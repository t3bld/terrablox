import {
  CloudFormationClient,
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStackEventsCommand,
  DescribeStacksCommand,
  UpdateStackCommand,
} from "@aws-sdk/client-cloudformation";
import {
  AddClientIDToOpenIDConnectProviderCommand,
  GetOpenIDConnectProviderCommand,
  IAMClient,
  ListOpenIDConnectProvidersCommand,
} from "@aws-sdk/client-iam";
import { AwsConnectionError } from "./connection";
import { GITHUB_OIDC_PROVIDER } from "./github-oidc";
import { type ProjectAwsSession, toClientCredentials } from "./session";

/**
 * Running the deployment prerequisites from the app instead of from a terminal.
 *
 * The template has always been correct; what stalled projects was the step in
 * between — copy a file out of the browser, find credentials, run a CLI, then
 * copy three ARNs back in. Nothing about that is safer than doing it here, and
 * the stack stays exactly as reviewable and as deletable as before.
 */

/** Outputs the role template promises; the name is part of its contract. */
export const DEPLOY_ROLE_OUTPUT = "DeployRoleArn";

export interface BootstrapStackState {
  stackName: string;
  /**
   * The stack's ARN, which is what the console links by.
   *
   * Carried rather than rebuilt from the name: the ARN also names the region and
   * the account the stack really lives in, so a link made from it cannot point at
   * the wrong one after somebody edits the project's region.
   */
  stackId: string | null;
  /** CloudFormation's own status, e.g. `CREATE_IN_PROGRESS`. */
  status: string;
  statusReason: string | null;
  /** True once the stack is settled, so the UI knows to stop polling. */
  settled: boolean;
  /** True only when it settled successfully. */
  succeeded: boolean;
  outputs: Record<string, string>;
}

const SETTLED = /_(COMPLETE|FAILED)$/;
const SUCCEEDED = new Set([
  "CREATE_COMPLETE",
  "UPDATE_COMPLETE",
  "UPDATE_ROLLBACK_COMPLETE",
]);

function client(session: ProjectAwsSession): CloudFormationClient {
  return new CloudFormationClient({
    region: session.region,
    credentials: toClientCredentials(session),
  });
}

function errorName(error: unknown): string {
  return typeof error === "object" && error !== null && "name" in error
    ? String((error as { name: unknown }).name)
    : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reports the stack, or null when it was never created.
 *
 * Read-only, and the thing the UI polls: CloudFormation returns immediately
 * from a create, so "did it work" is always a second question.
 */
/**
 * Asks CloudFormation to delete a bootstrap stack.
 *
 * Returns as soon as the request is accepted; the stack then sits in
 * `DELETE_IN_PROGRESS` for a while. Nothing here waits for it, for the same reason
 * nothing waits for a create.
 *
 * What actually disappears is the template's decision, not ours. The role stack's
 * contents go, so the deploy role and — if this stack created it rather than
 * reusing one — the account's GitHub identity provider go with them. The state
 * stack's contents are all marked to retain, so its bucket, lock table and key
 * survive their stack and stay in the account as orphans. That asymmetry is
 * deliberate: a role is recreatable in a minute, and a state bucket is the only
 * record of what Terraform has built.
 */
export async function deleteBootstrapStack(
  session: ProjectAwsSession,
  stackName: string,
): Promise<void> {
  try {
    await client(session).send(
      new DeleteStackCommand({ StackName: stackName }),
    );
  } catch (error) {
    throw new AwsConnectionError(
      `Could not delete the stack ${stackName}: ${errorMessage(error)}`,
      errorName(error) === "AccessDenied" ? "denied" : "failed",
    );
  }
}

export async function describeBootstrapStack(
  session: ProjectAwsSession,
  stackName: string,
): Promise<BootstrapStackState | null> {
  try {
    const result = await client(session).send(
      new DescribeStacksCommand({ StackName: stackName }),
    );

    const stack = result.Stacks?.[0];
    if (!stack?.StackStatus) return null;

    const outputs: Record<string, string> = {};
    for (const output of stack.Outputs ?? []) {
      if (output.OutputKey && output.OutputValue) {
        outputs[output.OutputKey] = output.OutputValue;
      }
    }

    const succeeded = SUCCEEDED.has(stack.StackStatus);

    return {
      stackName,
      stackId: stack.StackId ?? null,
      status: stack.StackStatus,
      statusReason: succeeded
        ? (stack.StackStatusReason ?? null)
        : ((await firstFailureReason(session, stackName)) ??
          stack.StackStatusReason ??
          null),
      settled: SETTLED.test(stack.StackStatus),
      succeeded,
      outputs,
    };
  } catch (error) {
    // CloudFormation reports an unknown stack as a validation error, which is
    // the normal answer before the first run rather than something to raise.
    if (/does not exist/i.test(errorMessage(error))) return null;
    if (errorName(error) === "AccessDenied") {
      throw new AwsConnectionError(
        "The connected role may not read CloudFormation stacks.",
        "denied",
      );
    }
    throw new AwsConnectionError(errorMessage(error), "unknown");
  }
}

/**
 * The reason the first resource gave for failing, rather than the stack's summary.
 *
 * `StackStatusReason` on a rolled-back create is "The following resource(s) failed
 * to create: [StateBucket]." — it names the resource and not the problem, and the
 * problem is the only part anybody can act on. One level down sits the sentence
 * that matters: "terrablox-…-tfstate-545283928770 already exists".
 *
 * Fetched only for a stack that is not succeeding, and it has to be fetched *now*:
 * these stacks are created with `OnFailure: DELETE`, so within a minute the stack is
 * gone and its events go with it. Reading it while the stack is still winding down
 * is the only chance there is.
 *
 * Returns null on any trouble of its own. This is a refinement of an error we can
 * already report, so failing to refine it must not replace it.
 */
async function firstFailureReason(
  session: ProjectAwsSession,
  stackName: string,
): Promise<string | null> {
  try {
    const events = await client(session).send(
      new DescribeStackEventsCommand({ StackName: stackName }),
    );

    // Oldest first: the first resource to fail is the cause, and the ones after it
    // usually failed because the rollback cancelled them.
    const failures = (events.StackEvents ?? [])
      .filter(
        (event) =>
          event.ResourceStatus?.endsWith("_FAILED") &&
          event.ResourceStatusReason &&
          // The stack's own event repeats the summary this exists to replace.
          event.ResourceType !== "AWS::CloudFormation::Stack" &&
          !/^Resource creation cancelled$/i.test(event.ResourceStatusReason),
      )
      .reverse();

    const first = failures[0];
    if (!first?.ResourceStatusReason) return null;

    return first.LogicalResourceId
      ? `${first.LogicalResourceId}: ${first.ResourceStatusReason}`
      : first.ResourceStatusReason;
  } catch {
    return null;
  }
}

/** The audience the role's trust policy requires, and the provider must accept. */
export const STS_AUDIENCE = "sts.amazonaws.com";

export interface GithubOidcProviderState {
  /** The provider's ARN, or null when the account has none for GitHub. */
  arn: string | null;
  /**
   * Whether it accepts {@link STS_AUDIENCE}.
   *
   * The half that used to be missing, and the reason a fully correct role could
   * still not be assumed. A provider's URL and its audience list are two separate
   * facts, and the trust policy needs both: it requires
   * `token.actions.githubusercontent.com:aud` to equal `sts.amazonaws.com`, which
   * only holds if the provider itself was registered for that audience.
   */
  acceptsSts: boolean;
}

/**
 * What this account's GitHub identity provider looks like, if it has one.
 *
 * IAM allows exactly one provider per URL, account-wide. The role stack creates
 * one, so the second project set up in the same account used to fail on that
 * resource with `AlreadyExists` — and because the create is made with
 * `OnFailure: DELETE`, CloudFormation then removed the whole stack again. What the
 * user saw was a button that turned into `DELETE_IN_PROGRESS` and a wizard that
 * reset itself with nothing to read. Asking first turns that into a parameter.
 *
 * It reads the audience as well as the URL, which is the part it did not do before.
 * A provider registered for some other audience — by another tool, or by hand —
 * answered "yes, GitHub is trusted here", so the stack was told not to manage it
 * and never corrected it. The role then came out perfect and unusable: STS refused
 * every assume with `Not authorized to perform sts:AssumeRoleWithWebIdentity`, and
 * because the same wrong answer came back every time, re-running the whole setup
 * changed nothing. Nothing in the flow could see it, because nothing looked.
 *
 * Null means "could not tell" — the session may not read IAM — and the caller then
 * tries to create the provider, which is the only answer that works on a fresh
 * account.
 */
export async function readGithubOidcProvider(
  session: ProjectAwsSession,
): Promise<GithubOidcProviderState | null> {
  // IAM is global; the region only decides which endpoint answers.
  const iam = new IAMClient({
    region: session.region,
    credentials: toClientCredentials(session),
  });

  try {
    const list = await iam.send(new ListOpenIDConnectProvidersCommand({}));
    const arn =
      (list.OpenIDConnectProviderList ?? []).find((provider) =>
        provider.Arn?.endsWith(`:oidc-provider/${GITHUB_OIDC_PROVIDER}`),
      )?.Arn ?? null;

    if (!arn) return { arn: null, acceptsSts: false };

    const described = await iam.send(
      new GetOpenIDConnectProviderCommand({
        OpenIDConnectProviderArn: arn,
      }),
    );

    return {
      arn,
      acceptsSts: (described.ClientIDList ?? []).includes(STS_AUDIENCE),
    };
  } catch {
    return null;
  }
}

/**
 * Teaches an existing provider to accept the audience the role asks for.
 *
 * Additive and idempotent: it appends to the client id list and removes nothing, so
 * whatever else in the account was using that provider goes on working. This is the
 * only repair available — IAM will not allow a second provider for the same URL, and
 * CloudFormation cannot adopt one it did not create, so the choice is between fixing
 * this in place and telling the user to go and do it by hand.
 *
 * Failure is reported rather than raised: the setup is still worth continuing, and
 * the checklist says the trust is not usable yet.
 */
export async function allowStsAudience(
  session: ProjectAwsSession,
  providerArn: string,
): Promise<boolean> {
  const iam = new IAMClient({
    region: session.region,
    credentials: toClientCredentials(session),
  });

  try {
    await iam.send(
      new AddClientIDToOpenIDConnectProviderCommand({
        OpenIDConnectProviderArn: providerArn,
        ClientID: STS_AUDIENCE,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates the stack, or updates it when it is already there.
 *
 * Update rather than "already exists, do it yourself": the template changes
 * whenever the project's branch, bucket or repository does, and a stack that
 * can only be created once would drift the first time any of those is edited.
 */
export async function applyBootstrapStack(
  session: ProjectAwsSession,
  input: {
    stackName: string;
    template: string;
    /**
     * Always passed in full, never partially. CloudFormation resets any
     * parameter an update omits back to the template default, so leaving one
     * out would quietly undo it on the next run.
     */
    parameters?: Record<string, string>;
  },
): Promise<{ started: boolean }> {
  const cfn = client(session);

  const shared = {
    StackName: input.stackName,
    TemplateBody: input.template,
    // The template names the role, so CloudFormation needs this acknowledged.
    Capabilities: ["CAPABILITY_NAMED_IAM" as const],
    Tags: [{ Key: "ManagedBy", Value: "Terrablox" }],
    Parameters: Object.entries(input.parameters ?? {}).map(([key, value]) => ({
      ParameterKey: key,
      ParameterValue: value,
    })),
  };

  try {
    await cfn.send(new CreateStackCommand({ ...shared, OnFailure: "DELETE" }));
    return { started: true };
  } catch (error) {
    if (errorName(error) !== "AlreadyExistsException") {
      throw toApplyError(error);
    }
  }

  try {
    await cfn.send(new UpdateStackCommand(shared));
    return { started: true };
  } catch (error) {
    // An update with nothing to change is success phrased as a failure.
    if (/No updates are to be performed/i.test(errorMessage(error))) {
      return { started: false };
    }
    throw toApplyError(error);
  }
}

function toApplyError(error: unknown): AwsConnectionError {
  if (errorName(error) === "AccessDenied") {
    return new AwsConnectionError(
      "The connected role may not create this stack. It needs permission for IAM, S3 and CloudFormation.",
      "denied",
    );
  }
  return new AwsConnectionError(errorMessage(error), "unknown");
}
