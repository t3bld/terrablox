import "server-only";

import {
  CloudFormationClient,
  CreateStackCommand,
  DescribeStacksCommand,
  UpdateStackCommand,
} from "@aws-sdk/client-cloudformation";
import {
  IAMClient,
  ListOpenIDConnectProvidersCommand,
} from "@aws-sdk/client-iam";

import { GITHUB_OIDC_PROVIDER } from "@/lib/projects/deploy";

import { AwsConnectionError } from "./connection";
import { type ProjectAwsSession, toClientCredentials } from "./credentials";

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

    return {
      stackName,
      stackId: stack.StackId ?? null,
      status: stack.StackStatus,
      statusReason: stack.StackStatusReason ?? null,
      settled: SETTLED.test(stack.StackStatus),
      succeeded: SUCCEEDED.has(stack.StackStatus),
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
 * Whether this account already trusts GitHub Actions.
 *
 * IAM allows exactly one identity provider per URL, account-wide. The role stack
 * creates one, so the second project set up in the same account used to fail on
 * that resource with `AlreadyExists` — and because the create is made with
 * `OnFailure: DELETE`, CloudFormation then removed the whole stack again. What
 * the user saw was a button that turned into `DELETE_IN_PROGRESS` and a wizard
 * that reset itself with nothing to read.
 *
 * Asking first turns that into a parameter. Null means "could not tell" — the
 * session may not list providers — and the caller then tries to create it, which
 * is the only answer that works on a fresh account.
 */
export async function hasGithubOidcProvider(
  session: ProjectAwsSession,
): Promise<boolean | null> {
  // IAM is global; the region only decides which endpoint answers.
  const iam = new IAMClient({
    region: session.region,
    credentials: toClientCredentials(session),
  });

  try {
    const result = await iam.send(new ListOpenIDConnectProvidersCommand({}));

    return (result.OpenIDConnectProviderList ?? []).some((provider) =>
      provider.Arn?.endsWith(`:oidc-provider/${GITHUB_OIDC_PROVIDER}`),
    );
  } catch {
    return null;
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
    Tags: [{ Key: "ManagedBy", Value: "TerraBlox" }],
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
