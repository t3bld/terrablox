import type { Project } from "@terrablox/database";
import { NextResponse } from "next/server";

import {
  getCurrentUserId,
  getProviderTokenForRequest,
} from "@/lib/auth/server-helpers";
import {
  applyBootstrapStack,
  DEPLOY_ROLE_OUTPUT,
  describeBootstrapStack,
  hasGithubOidcProvider,
} from "@/lib/aws/bootstrap";
import { resolveProjectAwsSession } from "@/lib/aws/credentials";
import { awsRouteError } from "@/lib/aws/route-error";
import { database } from "@/lib/database";
import { setRepoVariable } from "@/lib/github/actions-config";
import {
  AWS_REGION_VARIABLE,
  AWS_ROLE_VARIABLE,
  bootstrapStackName,
  CREATE_OIDC_PARAMETER,
  DEPLOY_PERMISSIONS_POLICY_ARN,
  defaultKmsAlias,
  defaultLockTable,
  defaultStateBucket,
  KMS_KEY_OUTPUT_KEY,
  LOCK_TABLE_OUTPUT_KEY,
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
    stateLockTable?: string;
    roleStackName?: string;
    stateStackName?: string;
    stateKmsAlias?: string;
  } = {};

  if (!project.awsAccountId && account) data.awsAccountId = account;
  if (!project.stateBucket && account) {
    data.stateBucket = defaultStateBucket(project.name, account);
  }
  if (!project.stateLockTable) {
    data.stateLockTable = defaultLockTable(project.name);
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

/** Reports both stacks. Safe to poll while either is still building. */
export async function GET(_req: Request, { params }: Params) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

  try {
    const [role, state] = await Promise.all([
      describeBootstrapStack(resolved.session, roleStackNameOf(project)),
      describeBootstrapStack(resolved.session, stateStackNameOf(project)),
    ]);

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
      drift: { role: roleDrift, state: stateDrift },
    });
  } catch (error) {
    return awsRouteError(error);
  }
}

export async function POST(req: Request, { params }: Params) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const project = await findOwnedProject(userId, params.projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    action?: unknown;
    stack?: unknown;
    createOidcProvider?: unknown;
  };

  const stack = parseStack(body.stack);
  const action =
    body.action === "adopt"
      ? "adopt"
      : body.action === "reset"
        ? "reset"
        : "apply";

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

      // An account can hold only one identity provider per URL, so whether to
      // create it is a fact about the account rather than a question for the
      // user: asked here, the second project in an account succeeds instead of
      // failing on that one resource and taking its own stack down with it. The
      // caller can still force reuse; it cannot force a create that IAM refuses.
      const reuseOidcProvider =
        stack === "role" &&
        (body.createOidcProvider === false ||
          (await hasGithubOidcProvider(resolved.session)) === true);

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
          stateLockTable:
            described.outputs[LOCK_TABLE_OUTPUT_KEY] ?? project.stateLockTable,
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
    stateLockTable: project.stateLockTable,
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
