import {
  allowStsAudience,
  applyBootstrapStack,
  DEPLOY_ROLE_OUTPUT,
  deleteBootstrapStack,
  describeBootstrapStack,
  readGithubOidcProvider,
} from "@terrablox/aws/bootstrap";
import type { Project } from "@terrablox/database";
import { setRepoVariable } from "@terrablox/git/actions";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  parseJsonBody,
  requireUserId,
  requireUserWithLimit,
} from "@/lib/api/guard";
import { RATE_LIMITS } from "@/lib/api/rate-limit";
import { awsRouteError, routeError } from "@/lib/api/route-error";
import { audit } from "@/lib/audit/log";
import { getProviderTokenForRequest } from "@/lib/auth/server-helpers";
import { resolveProjectAwsSession } from "@/lib/aws/credentials";
import { database } from "@/lib/database";
import {
  AWS_REGION_VARIABLE,
  AWS_ROLE_VARIABLE,
  bootstrapStackName,
  CREATE_OIDC_PARAMETER,
  DEPLOY_PERMISSIONS_POLICY_ARN,
  defaultKmsAlias,
  KMS_KEY_OUTPUT_KEY,
  newStateBucketName,
  PERMISSIONS_POLICY_PARAMETER,
  renderBootstrapTemplate,
  renderStateTemplate,
  STATE_BUCKET_OUTPUT_KEY,
  STATE_BUCKET_VARIABLE,
  stateStackName,
} from "@/lib/projects/deploy";
import {
  pipelineContext,
  roleStackNameOf,
  stateStackNameOf,
} from "@/lib/projects/deploy-service";
import { findOwnedProject } from "@/lib/projects/service";

/**
 * The account-side prerequisites, run from the app.
 *
 * Two stacks, not one. The role can be rebuilt at will; the state bucket and its
 * key cannot, because deleting them loses track of infrastructure that is still
 * running. Splitting them means a change to either can never put the other at
 * risk, and it is why the wizard asks for them as separate steps.
 *
 * Each stack has two deliberate phases: creating it writes to the customer's
 * account, adopting its outputs rewrites this project and the repository's
 * Actions configuration. Neither should ever happen as a side effect of opening
 * a page, so `GET` only ever reports.
 */

interface Params {
  params: { projectId: string };
}

type StackKind = "role" | "state";

/**
 * What the project points at, when the stack that should own it is not there.
 *
 * The distinction this exists to draw: a project with no role and no bucket has
 * never been set up, and the wizard should offer to create them. A project that
 * holds a role ARN whose stack cannot be described has been set up *somewhere
 * else* — and those two look identical from `setup.roleReady` alone, so the wizard
 * used to offer a create that could not succeed. The role name is recovered from
 * the stored ARN, so creating again in the same account collides with the role
 * that is still there, and `OnFailure: DELETE` then removes the new stack: a loop
 * with no way out of it on this screen.
 */
interface StackDrift {
  /** The stack we looked for and did not find. */
  stackName: string;
  /** Where we looked. */
  region: string;
  accountId: string | null;
  /** The role ARN or bucket name the project is still holding. */
  pointsAt: string;
  /** The account that name belongs to, where it can be told. */
  pointsAtAccount: string | null;
  /**
   * Whether a fresh create here would collide with what is already there.
   *
   * IAM is global and S3 bucket names are, so "the same account" decides it for the
   * role, and for the state it is decided already: the bucket name is a stored
   * column carrying the old account id, so re-creating it fails wherever we are.
   */
  collides: boolean;
}

/** The account an IAM ARN belongs to: `arn:aws:iam::123456789012:role/name`. */
function accountOfArn(arn: string): string | null {
  const account = arn.split(":")[4];
  return account && /^\d{12}$/.test(account) ? account : null;
}

function parseStack(value: unknown): StackKind {
  return value === "state" ? "state" : "role";
}

/**
 * Fills in the names nobody should have to invent.
 *
 * The state bucket is the awkward one: CloudFormation needs its name up front,
 * and S3 names are globally unique, so a hand-typed guess is usually already
 * taken and only fails once the stack is halfway through. The account id comes
 * from the session rather than from the form, because the session is the thing
 * that actually proves which account this is.
 *
 * Existing values are never overwritten — a project that already deploys
 * somewhere must not be moved by a setup re-run.
 */
async function ensureDerivedSettings(
  project: Project,
  accountId: string | null,
): Promise<Project> {
  const account = project.awsAccountId ?? accountId;

  const data: {
    awsAccountId?: string;
    stateBucket?: string;
    roleStackName?: string;
    stateStackName?: string;
    stateKmsAlias?: string;
  } = {};

  if (!project.awsAccountId && account) data.awsAccountId = account;

  // Minted here, and only where there is none: the name carries a random tail, so
  // calling this twice would name two buckets. `!project.stateBucket` is what makes
  // it happen once — and what makes a project that was reset get a *new* name
  // rather than the one whose bucket is still standing in the account.
  if (!project.stateBucket && account) {
    data.stateBucket = newStateBucketName(project.name, account);
  }

  // The stack names and the alias, pinned on the first apply for the same reason
  // the bucket is: they are derived from the project's name, and the name can be
  // changed afterwards. Derived fresh every time, a rename made `DescribeStacks`
  // look for a stack nobody had created — so the wizard called the setup
  // unfinished, and the create it offered then collided with the role that was
  // still there under its old name and took itself down with `OnFailure: DELETE`.
  //
  // Written here rather than at the point of use, because "the first apply" is the
  // only moment at which the derivation is still the right answer.
  if (!project.roleStackName) {
    data.roleStackName = bootstrapStackName(project.name);
  }
  if (!project.stateStackName) {
    data.stateStackName = stateStackName(project.name);
  }
  if (!project.stateKmsAlias) {
    data.stateKmsAlias = defaultKmsAlias(project.name);
  }

  if (Object.keys(data).length === 0) return project;

  return database.project.update({ where: { id: project.id }, data });
}

/**
 * Reports both stacks. Safe to poll while either is still building.
 *
 * `?deleting=<stackName>` asks after a stack by name, and is how the wizard waits
 * out a deletion. It needs it because deleting forgets the stack in the same
 * breath: once the pointer is gone there is no stored name left to poll, and the
 * caller is the only one that still knows which stack it just took down.
 *
 * Repeatable, and answered with the subset that still exists. Both stacks can be
 * coming down at once — tearing a project down is exactly that — and a single name
 * meant the second deletion overwrote the first, which was then never seen to
 * finish. Reporting which ones remain rather than a bare "still deleting" is what
 * lets each step decide for itself, instead of both waiting on whichever was last.
 *
 * Read-only, and against the caller's own account — the same session that may
 * create and delete stacks there.
 */
export async function GET(req: Request, { params }: Params) {
  let userId: string;
  try {
    userId = await requireUserId({ action: "deploy.bootstrap.read" });
  } catch (e) {
    return routeError("deploy.bootstrap.read", e);
  }

  const project = await findOwnedProject(userId, params.projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const resolved = await resolveProjectAwsSession(userId, project);
  if (!resolved.ok) {
    // A project without a connection is an ordinary early state, and the page
    // needs the reason to offer the right next step.
    return NextResponse.json({
      connected: false,
      reason: resolved.reason,
      message: resolved.message,
      role: null,
      state: null,
    });
  }

  // Deduplicated, and capped: the names come from a query string, and describing
  // one stack per entry is a loop over caller-supplied input.
  const deletingNames = [
    ...new Set(
      new URL(req.url).searchParams
        .getAll("deleting")
        .map((name) => name.trim())
        .filter((name) => name.length > 0),
    ),
  ].slice(0, 2);

  try {
    const [role, state, ...asked] = await Promise.all([
      describeBootstrapStack(resolved.session, roleStackNameOf(project)),
      describeBootstrapStack(resolved.session, stateStackNameOf(project)),
      ...deletingNames.map((name) =>
        describeBootstrapStack(resolved.session, name),
      ),
    ]);

    // The names that still answer. A stack mid-deletion is `DELETE_IN_PROGRESS`
    // and describable; once it is gone, `describeBootstrapStack` returns null.
    const deleting = deletingNames.filter((_, index) => asked[index] !== null);

    /**
     * Whether the account still has the identity provider the role trusts.
     *
     * Checked because the role can be perfectly formed and still unusable. The
     * provider is account-wide and shared by every project here, so it belongs to
     * whichever project's stack created it first — and if that stack was deleted,
     * this role's trust policy goes on naming a principal that is gone. Nothing
     * about the role, the stack or the stored ARN changes, so the setup reads as
     * finished and the failure surfaces minutes later inside a workflow, as
     * `Not authorized to perform sts:AssumeRoleWithWebIdentity` — pointing at the
     * role, which is the one place the cause is not.
     *
     * Only asked once the role stack has succeeded: before that the answer is
     * either irrelevant or about to change, and this would otherwise be an IAM call
     * on every poll of a building stack. Null means the session could not tell,
     * which is reported as unknown rather than as missing — a session that may not
     * list providers must not make a working setup look broken.
     */
    const provider = role?.succeeded
      ? await readGithubOidcProvider(resolved.session)
      : null;

    // Three answers, not two, and the middle one is the one that used to be
    // invisible: no provider at all, one that will not accept the audience the
    // role asks for, or a working trust. Null still means "could not tell".
    const oidcProvider =
      provider === null
        ? null
        : provider.arn === null
          ? "missing"
          : provider.acceptsSts
            ? "ready"
            : "wrong-audience";

    const here = resolved.session.accountId;

    // Read off the outputs the stacks produced, not off the names derived for
    // them: `stateBucket` is filled in before the state stack runs, so its
    // presence says nothing about whether anything was created. The KMS key ARN
    // and the role ARN are only ever written by adopting a stack that succeeded,
    // which makes them the honest evidence that a setup happened.
    const roleDrift: StackDrift | null =
      project.awsRoleArn && !role
        ? {
            stackName: roleStackNameOf(project),
            region: project.awsRegion,
            accountId: here,
            pointsAt: project.awsRoleArn,
            pointsAtAccount: accountOfArn(project.awsRoleArn),
            collides: accountOfArn(project.awsRoleArn) === here,
          }
        : null;

    const stateDrift: StackDrift | null =
      project.stateKmsKeyArn && project.stateBucket && !state
        ? {
            stackName: stateStackNameOf(project),
            region: project.awsRegion,
            accountId: here,
            pointsAt: project.stateBucket,
            pointsAtAccount: accountOfArn(project.stateKmsKeyArn),
            // Always. The bucket name is stored and carries the account it was
            // made for, and S3 names are global, so creating it again fails in
            // this account and in any other.
            collides: true,
          }
        : null;

    return NextResponse.json({
      connected: true,
      role,
      state,
      // Null both when nothing was asked about and when the stack has finished
      // going, which is the same answer to the only question the caller has.
      deleting,
      oidcProvider,
      drift: { role: roleDrift, state: stateDrift },
    });
  } catch (error) {
    return awsRouteError(error);
  }
}

export async function POST(req: Request, { params }: Params) {
  // The infrastructure budget: this submits a CloudFormation stack into a customer's
  // AWS account, which creates real IAM roles and an encrypted state bucket.
  let userId: string;
  try {
    userId = await requireUserWithLimit(
      "deploy.bootstrap",
      RATE_LIMITS.infrastructure,
    );
  } catch (e) {
    return routeError("deploy.bootstrap", e);
  }

  const project = await findOwnedProject(userId, params.projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  let body: { action?: unknown; stack?: unknown; createOidcProvider?: unknown };
  try {
    // An empty body is meaningful here — it means the default `apply` — so the schema
    // defaults rather than requires. What it adds over `.catch(() => ({}))` is the
    // size cap and a rejection for a malformed body instead of silently treating it
    // as "apply", which is the one action with an effect in AWS.
    body = await parseJsonBody(
      req,
      z
        .object({
          action: z.enum(["apply", "adopt", "reset", "delete"]).optional(),
          stack: z.unknown().optional(),
          createOidcProvider: z.boolean().optional(),
        })
        .default({}),
    );
  } catch (e) {
    return routeError("deploy.bootstrap", e);
  }

  const stack = parseStack(body.stack);
  const action = body.action ?? "apply";

  /**
   * Forgets a bootstrap this project can no longer reach, so a fresh one can be
   * built here.
   *
   * Touches nothing in AWS. That is the whole design: the role and the bucket this
   * clears are still there, in whichever account and region they were created in,
   * and deleting them from here would be the one irreversible thing in this flow —
   * a state bucket holds the only record of what Terraform has built.
   *
   * It is therefore not "delete and recreate", it is "stop pointing at that one".
   * Offered only where the drift report says a fresh create would not collide,
   * because clearing the pointers cannot make an existing IAM role or an existing
   * bucket name go away, and a button that leaves you in the same trap is worse
   * than no button.
   */
  if (action === "reset") {
    await database.project.update({
      where: { id: project.id },
      data: {
        awsRoleArn: null,
        stateBucket: null,
        stateLockTable: null,
        stateKmsKeyArn: null,
        // The pinned identity goes with them. Keeping it would send the next apply
        // at a stack named for the setup that was just abandoned.
        roleStackName: null,
        stateStackName: null,
        stateKmsAlias: null,
      },
    });

    return NextResponse.json({ reset: true });
  }

  /**
   * Deletes one of the two stacks in AWS, then forgets it here.
   *
   * The counterpart to `reset` above, and the difference is the whole point: that
   * one stops pointing at a stack and leaves it standing, this one takes it down.
   * Both are needed because they answer opposite questions — "this was set up
   * somewhere I can no longer reach" against "I want this gone".
   *
   * Deleting in AWS first, and only clearing the pointers once CloudFormation has
   * accepted it. A refused delete has to leave the project still pointing at the
   * stack that is still there, or the wizard would offer to create a second one
   * beside it.
   *
   * The pointers do go immediately, though, rather than waiting for the stack to
   * finish disappearing. It leaves a gap in which the step reads "not set up" while
   * a stack is still in `DELETE_IN_PROGRESS`, and a create started inside that gap
   * is refused by CloudFormation. That is a plain error and it self-corrects on the
   * next press, which is better than the alternative: keeping the pointers means
   * the drift check sees a project claiming a stack that no longer answers, and
   * offers a recovery for a problem the user has just deliberately caused.
   */
  if (action === "delete") {
    const resolved = await resolveProjectAwsSession(userId, project, "write");
    if (!resolved.ok) {
      return NextResponse.json({ error: resolved.message }, { status: 400 });
    }

    const stackName =
      stack === "state" ? stateStackNameOf(project) : roleStackNameOf(project);

    try {
      await deleteBootstrapStack(resolved.session, stackName);
    } catch (error) {
      return awsRouteError(error);
    }

    // Only the half that was deleted. The two stacks have separate lifetimes, and
    // clearing the state pointers because the role went would tell the user their
    // Terraform state was gone when the bucket is untouched.
    await database.project.update({
      where: { id: project.id },
      data:
        stack === "state"
          ? {
              stateBucket: null,
              stateLockTable: null,
              stateKmsKeyArn: null,
              stateStackName: null,
              stateKmsAlias: null,
            }
          : { awsRoleArn: null, roleStackName: null },
    });

    return NextResponse.json({ deleted: true, stackName });
  }

  if (action === "apply") {
    const resolved = await resolveProjectAwsSession(userId, project, "write");
    if (!resolved.ok) {
      return NextResponse.json({ error: resolved.message }, { status: 400 });
    }

    try {
      // Both stacks need the derived names: the role scopes its policy to the
      // bucket, and the state stack creates it.
      const prepared = await ensureDerivedSettings(
        project,
        resolved.session.accountId,
      );

      // `prepared`, not `project`: the pin above may have just been written, and
      // reading the stale row would create the stack under a name the project has
      // already stopped using.
      const stackName =
        stack === "state"
          ? stateStackNameOf(prepared)
          : roleStackNameOf(prepared);

      const context = pipelineContext(prepared);

      /**
       * Whether to leave the identity provider to a stack that already owns it.
       *
       * An account can hold only one per URL, so this is a fact about the account
       * rather than a question for the user: asked here, the second project in an
       * account succeeds instead of failing on that one resource and taking its own
       * stack down with it. The caller can still force reuse; it cannot force a
       * create that IAM refuses.
       *
       * Reuse now depends on the provider being *usable*, not merely present. One
       * registered for a different audience answered "GitHub is trusted here", so
       * the stack was told not to manage it, and the role came out perfectly formed
       * and impossible to assume — with the same wrong answer returned on every
       * retry, so redoing the entire setup changed nothing. Where that is the case
       * the audience is added first, which is additive and leaves whatever else was
       * using the provider alone; IAM will not allow a second provider for the URL
       * and CloudFormation cannot adopt one it did not create, so repairing it in
       * place is the only fix that exists.
       */
      let reuseOidcProvider = false;
      if (stack === "role") {
        const provider = await readGithubOidcProvider(resolved.session);

        if (body.createOidcProvider === false) {
          reuseOidcProvider = true;
        } else if (provider?.arn) {
          if (!provider.acceptsSts) {
            await allowStsAudience(resolved.session, provider.arn);
          }
          reuseOidcProvider = true;
        }
        // A null read means IAM could not be asked. Creating is the only answer
        // that works on a fresh account, and a create that collides is refused by
        // CloudFormation with its own message rather than silently doing nothing.
      }

      const result = await applyBootstrapStack(resolved.session, {
        stackName,
        template:
          stack === "state"
            ? renderStateTemplate(context)
            : renderBootstrapTemplate(context),
        parameters:
          stack === "state"
            ? {}
            : {
                [PERMISSIONS_POLICY_PARAMETER]: DEPLOY_PERMISSIONS_POLICY_ARN,
                [CREATE_OIDC_PARAMETER]: reuseOidcProvider ? "no" : "yes",
              },
      });

      // A stack submission creates IAM roles and an encrypted state bucket in
      // somebody's AWS account. Recorded after the call so the row means "submitted",
      // and with the account and stack named so it can be reconciled against
      // CloudTrail on the other side.
      await audit({
        action: "deploy.bootstrap.submitted",
        userId,
        subject: project.id,
        detail: {
          stack,
          stackName,
          awsAccountId: project.awsAccountId,
          region: resolved.session.region,
          reusedOidcProvider: reuseOidcProvider,
        },
      });

      return NextResponse.json({
        started: result.started,
        reusedOidcProvider: reuseOidcProvider,
        stack: await describeBootstrapStack(resolved.session, stackName),
      });
    } catch (error) {
      return awsRouteError(error);
    }
  }

  const resolved = await resolveProjectAwsSession(userId, project);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.message }, { status: 400 });
  }

  try {
    const stackName =
      stack === "state" ? stateStackNameOf(project) : roleStackNameOf(project);

    const described = await describeBootstrapStack(resolved.session, stackName);

    if (!described?.succeeded) {
      return NextResponse.json(
        { error: "The stack has not finished successfully yet." },
        { status: 409 },
      );
    }

    if (stack === "state") {
      const updated = await database.project.update({
        where: { id: project.id },
        data: {
          stateBucket:
            described.outputs[STATE_BUCKET_OUTPUT_KEY] ?? project.stateBucket,
          stateKmsKeyArn:
            described.outputs[KMS_KEY_OUTPUT_KEY] ?? project.stateKmsKeyArn,
        },
      });

      const github = await writeVariables(req, updated);

      return NextResponse.json({
        stack: described,
        github,
        settings: settingsOf(updated),
      });
    }

    const updated = await database.project.update({
      where: { id: project.id },
      data: {
        awsRoleArn: described.outputs[DEPLOY_ROLE_OUTPUT] ?? project.awsRoleArn,
        // The stack proves which account it ran in, so stop guessing.
        awsAccountId: resolved.session.accountId ?? project.awsAccountId,
      },
    });

    const github = await writeVariables(req, updated);

    return NextResponse.json({
      stack: described,
      github,
      settings: settingsOf(updated),
    });
  } catch (error) {
    return awsRouteError(error);
  }
}

function settingsOf(project: Project) {
  return {
    awsAccountId: project.awsAccountId,
    awsRegion: project.awsRegion,
    awsRoleArn: project.awsRoleArn,
    stateBucket: project.stateBucket,
    stateKmsKeyArn: project.stateKmsKeyArn,
  };
}

/**
 * Mirrors the settings into the repository's Actions variables.
 *
 * Best-effort on purpose: the project row is what this app needs, and a GitHub
 * permission the installation was never granted should not undo a stack that
 * worked. The workflows fall back to the values rendered into them, so a failure
 * here degrades rather than breaks.
 */
async function writeVariables(
  req: Request,
  project: Project,
): Promise<{ written: boolean; error: string | null }> {
  const token = await getProviderTokenForRequest(req, project.provider);
  if (!token) return { written: false, error: "GitHub is not connected." };

  const variables: [string, string | null][] = [
    [AWS_ROLE_VARIABLE, project.awsRoleArn],
    [AWS_REGION_VARIABLE, project.awsRegion],
    [STATE_BUCKET_VARIABLE, project.stateBucket],
  ];

  try {
    for (const [name, value] of variables) {
      if (!value) continue;
      await setRepoVariable(token, {
        repoFullName: project.repoFullName,
        name,
        value,
      });
    }

    return { written: true, error: null };
  } catch (error) {
    return {
      written: false,
      error:
        error instanceof Error
          ? error.message
          : "Could not write the repository variables.",
    };
  }
}
