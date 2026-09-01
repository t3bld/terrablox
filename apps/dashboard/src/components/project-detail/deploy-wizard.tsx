"use client";

import { Button } from "@terrablox/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@terrablox/ui/card";
import { Input } from "@terrablox/ui/input";
import { Label } from "@terrablox/ui/label";
import { Skeleton } from "@terrablox/ui/skeleton";
import { ToggleRow } from "@terrablox/ui/toggle-row";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Clock,
  ExternalLink,
  FileCode2,
  KeyRound,
  Loader2,
  Lock,
  Plug,
  Rocket,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { AwsSsoConnect } from "@/components/account/aws-sso-connect";
import { AwsRegionPicker } from "@/components/aws-region-picker";
import { WizardSteps } from "@/components/layout/wizard-steps";
import {
  buildRoleChecklist,
  type ChecklistItem,
  type ChecklistState,
} from "@/lib/projects/deploy-checklist";
import type { ProjectDeployState } from "@/lib/projects/types";

interface StackDto {
  stackName: string;
  /** The stack ARN, which is what the console link is made from. */
  stackId: string | null;
  status: string;
  statusReason: string | null;
  settled: boolean;
  succeeded: boolean;
  outputs: Record<string, string>;
}

/**
 * A bootstrap this project points at but cannot reach from where it is now.
 *
 * Reported by the server rather than worked out here, because deciding it needs the
 * session's account id — which is the thing the browser is not told.
 */
interface DriftDto {
  stackName: string;
  region: string;
  accountId: string | null;
  pointsAt: string;
  pointsAtAccount: string | null;
  /** True when creating it again here would fail on a name already taken. */
  collides: boolean;
}

interface DeployWizardProps {
  projectId: string;
  state: ProjectDeployState;
  /** Re-reads the deploy state, because every step changes what the next sees. */
  onChanged: () => void | Promise<void>;
  /**
   * Points the project at an account the user just signed in to, in step one.
   *
   * Owned by the page rather than here, so the account line under the tab strip
   * learns about the new connection at the same moment this does.
   */
  onAttach: (accountId: string) => Promise<void>;
  /**
   * The account the project is pointed at, or null.
   *
   * Only used to notice that it changed: connecting or disconnecting elsewhere
   * on the page invalidates everything the wizard has read, and leaves it
   * showing a step whose prerequisite has just gone away.
   */
  awsAccountId?: string | null;
}

type StepId = "account" | "role" | "state" | "pipeline";

/**
 * What is in flight, which is finer-grained than the step.
 *
 * The role step has two buttons, and one spinner for both would show the stack
 * being created while the thing actually running is the save.
 */
type BusyKey = StepId | "role-variables";

/**
 * The one order that works. Module level, so it is stated once rather than
 * implied by where the JSX happens to sit.
 */
const ORDER: StepId[] = ["account", "role", "state", "pipeline"];

/** The last step, named rather than indexed, so it cannot be `undefined`. */
const FINAL_STEP: StepId = "pipeline";

const STEP_META: Record<
  StepId,
  {
    /** Kept to one word: five of them share the strip. */
    label: string;
    title: string;
    icon: typeof Plug;
    description?: string;
  }
> = {
  account: {
    label: "Account",
    title: "Connect the AWS account",
    icon: Plug,
  },
  // Creating the role and recording it are one step, not two: the stack is only
  // any use once the ARN it produced is where the workflow looks for it, and a
  // wizard that called those two things separately made the second look optional.
  role: {
    label: "Role",
    title: "Create the deployment role",
    icon: KeyRound,
  },
  state: {
    label: "State",
    title: "Deploy the state backend",
    icon: Lock,
    description:
      "A second stack for the Terraform state: a customer-managed KMS key, the versioned S3 bucket it encrypts, and the DynamoDB table that holds the lock.",
  },
  pipeline: {
    label: "Workflows",
    title: "Configure and commit the workflows",
    icon: FileCode2,
    description:
      "Writes the workflow templates and the S3 backend into the repository. They only ever start on workflow_dispatch, so committing them changes nothing on its own.",
  },
};

/**
 * The column the wizard sits in, shared by every tab that shows it.
 *
 * A centred, capped measure rather than a percentage of the panel: the steps are
 * forms and prose, and a percentage kept growing them past a comfortable line
 * length on a wide window while making them narrower on a laptop.
 */
export const WIZARD_COLUMN = "mx-auto w-full max-w-6xl space-y-4 p-6";

/**
 * The guided path from "a repository with Terraform in it" to "a button that
 * deploys it".
 *
 * Every piece of this was already reachable in the panel, and that was the
 * problem: independent controls with an order that only existed in somebody's
 * head, where doing them in the wrong sequence produced a CloudFormation error
 * rather than a hint. The steps here are the same calls in the one order that
 * works, and each one refuses to look done until the thing it created can
 * actually be read back.
 *
 * Nothing is remembered as progress — the state is derived from the account, the
 * repository and the project on every load, so deleting the workflow reopens
 * this wizard instead of leaving a tab that lies.
 */
export function DeployWizard({
  projectId,
  state,
  onChanged,
  onAttach,
  awsAccountId = null,
}: DeployWizardProps) {
  const [roleStack, setRoleStack] = useState<StackDto | null>(null);
  const [stateStack, setStateStack] = useState<StackDto | null>(null);
  const [drift, setDrift] = useState<{
    role: DriftDto | null;
    state: DriftDto | null;
  }>({ role: null, state: null });
  const [connection, setConnection] = useState<{
    connected: boolean;
    message: string | null;
  } | null>(null);
  const [busy, setBusy] = useState<BusyKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [region, setRegion] = useState(state.settings.awsRegion);
  const [reuseOidc, setReuseOidc] = useState(false);
  /**
   * The step the user asked to see, if they asked. Null follows the first
   * unfinished one, which is where anyone arriving here wants to be — but a
   * finished step has to stay readable, because "what did it call my bucket" is
   * a question that comes up after the step is done.
   */
  const [chosen, setChosen] = useState<StepId | null>(null);
  /** Set when writing the role into the repository failed on its own. */
  const [saveFailed, setSaveFailed] = useState(false);
  /**
   * Why the Actions variables were not written, when the rest of the save worked.
   *
   * Its own field rather than part of `error`: the role *is* saved at that point,
   * so a banner saying something failed would overstate it. It belongs to the one
   * checklist line it is about.
   */
  const [variablesError, setVariablesError] = useState<string | null>(null);
  /**
   * Whether the last run reused an identity provider that was already there.
   *
   * Worth reporting because it is the difference between "we created a trust
   * relationship in your account" and "we attached to the one you had", and the
   * stack status cannot show it. Held rather than announced in a banner, so it
   * reads as a detail of the step it belongs to.
   */
  const [reusedOidcProvider, setReusedOidcProvider] = useState(false);
  /**
   * Why the last role stack attempt did not survive.
   *
   * Kept separately from `error` because it has to outlive the stack it came
   * from: a create that fails is deleted again, so a poll or two later there is
   * nothing left to describe and the reason would vanish with it.
   */
  const [roleFailure, setRoleFailure] = useState<string | null>(null);

  /** The role stack as the previous read saw it, to notice it disappearing. */
  const lastRoleStack = useRef<StackDto | null>(null);

  const readStacks = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/projects/${projectId}/deploy/bootstrap`,
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error ?? "Failed to read");

      setConnection({
        connected: Boolean(body.connected),
        message: body.message ?? null,
      });

      const role = (body.role as StackDto | null) ?? null;
      const previous = lastRoleStack.current;
      lastRoleStack.current = role;

      if (role?.succeeded) setRoleFailure(null);
      else if (previous && !role && !previous.succeeded) {
        // The stack was rolled back and removed under us. Keep what it said, or
        // the wizard resets to a fresh "Create" button with no hint of why.
        setRoleFailure(
          previous.statusReason ??
            `CloudFormation rolled the stack back and removed it (${previous.status}).`,
        );
      }

      setRoleStack(role);
      setStateStack((body.state as StackDto | null) ?? null);

      const reported = body.drift as
        | { role: DriftDto | null; state: DriftDto | null }
        | undefined;
      setDrift({
        role: reported?.role ?? null,
        state: reported?.state ?? null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to read");
    }
  }, [projectId]);

  /** The account the last read was for. `undefined` means "not read yet". */
  const readFor = useRef<string | null | undefined>(undefined);

  // Re-read whenever the account changes, and go back to the first unfinished
  // step while doing it. Disconnecting from the strip above used to leave the
  // wizard on step three, offering a stack it could no longer reach.
  useEffect(() => {
    if (readFor.current === awsAccountId) return;
    readFor.current = awsAccountId;

    setChosen(null);
    setSaveFailed(false);
    void readStacks();
  }, [readStacks, awsAccountId]);

  /** Whether the connection was already there when this wizard last looked. */
  const wasConnected = useRef<boolean | null>(null);

  // Signing in completes step one's *prerequisite*, not step one: the region is
  // also on that screen, and it decides where the role, the bucket and every
  // later deployment are created. Jumping straight to step two took that choice
  // away without ever showing it. Only a sign-in that happened here pins the
  // view, so a returning user still lands on whatever is actually unfinished.
  useEffect(() => {
    if (connection === null) return;

    const previous = wasConnected.current;
    wasConnected.current = connection.connected;

    if (previous === false && connection.connected) setChosen("account");
  }, [connection]);

  // CloudFormation answers the moment it accepts the request, so whether it
  // worked is always a later question.
  const building =
    (roleStack !== null && !roleStack.settled) ||
    (stateStack !== null && !stateStack.settled);

  useEffect(() => {
    if (!building) return;
    const timer = setInterval(() => void readStacks(), 5000);
    return () => clearInterval(timer);
  }, [building, readStacks]);

  /**
   * Takes what the role stack produced and records it: the ARN and account id on
   * the project, and the Actions variables in the repository.
   *
   * Not built on `post` so it can be a stable callback for the effect below, and
   * so a failure can be remembered rather than only shown.
   */
  const saveRole = useCallback(async () => {
    setBusy("role-variables");
    setError(null);
    setNotice(null);

    try {
      const response = await fetch(
        `/api/projects/${projectId}/deploy/bootstrap`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "adopt", stack: "role" }),
        },
      );
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body?.error ?? "Could not save the role.");
      }

      const github = body.github as {
        written?: boolean;
        error?: string;
      } | null;
      // No banner: both halves of this are checklist lines, and a sentence
      // repeating them was the third place on screen saying the same thing.
      setVariablesError(
        github?.written
          ? null
          : (github?.error ??
              "Could not write the repository's Actions variables."),
      );
      setSaveFailed(false);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the role.");
      setSaveFailed(true);
    } finally {
      setBusy(null);
    }
  }, [projectId, onChanged]);

  /**
   * One attempt per stack outcome, tracked in a ref rather than in state.
   *
   * Without it the effect would re-fire on the render its own `setNotice` causes
   * and adopt the stack in a loop; with it, a failure waits for the user, who
   * gets a retry button.
   */
  const autoSaved = useRef<string | null>(null);

  // Saving is not a decision, so it is not a step: the moment CloudFormation
  // reports the role, its ARN is written where the pipeline looks for it.
  useEffect(() => {
    if (!roleStack?.succeeded) return;
    if (state.setup.roleReady && state.setup.variablesReady) return;

    const attempt = `${roleStack.stackName}:${roleStack.status}`;
    if (autoSaved.current === attempt) return;
    autoSaved.current = attempt;

    void saveRole();
  }, [roleStack, state.setup.roleReady, state.setup.variablesReady, saveRole]);

  /**
   * Stops pointing at a bootstrap this project can no longer reach.
   *
   * Nothing in AWS is touched — the role and the bucket stay where they were made.
   * Only offered where the drift report says a fresh create would not collide,
   * because clearing our own pointers cannot free an IAM role name or an S3 bucket
   * name that is still taken.
   */
  async function forgetSetup(stepId: BusyKey) {
    const body = await post(
      stepId,
      `/api/projects/${projectId}/deploy/bootstrap`,
      { action: "reset" },
    );
    if (!body) return;

    setRoleFailure(null);
    setVariablesError(null);
    setSaveFailed(false);
    await readStacks();
    await onChanged();
  }

  /** Attaches the account signed in to in step one, then re-reads the stacks. */
  const connectAccount = useCallback(
    async (created: { accountId: string | null }) => {
      if (!created.accountId) {
        setError("That sign-in did not report an account id.");
        return;
      }

      setBusy("account");
      setError(null);

      try {
        await onAttach(created.accountId);
        await readStacks();
        await onChanged();
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Could not attach that account.",
        );
      } finally {
        setBusy(null);
      }
    },
    [onAttach, readStacks, onChanged],
  );

  const done: Record<StepId, boolean> = {
    account: connection?.connected ?? false,
    // Both halves of the step: the role exists, and the pipeline can find it.
    role: state.setup.roleReady && state.setup.variablesReady,
    state: state.setup.stateReady,
    pipeline: state.setup.pipelineReady,
  };

  /** The role step has work in flight: the stack itself, or the save after it. */
  const roleRunning =
    busy === "role" ||
    busy === "role-variables" ||
    (roleStack !== null && !roleStack.settled);

  /**
   * The last attempt did not leave a usable stack.
   *
   * Two ways to be true, because a create made with `OnFailure: DELETE` erases
   * its own evidence: either the stack is still there and settled unsuccessfully,
   * or it is gone and `roleFailure` is what it said on the way out.
   */
  const roleFailed =
    roleFailure !== null || Boolean(roleStack?.settled && !roleStack.succeeded);

  const roleChecklist = buildRoleChecklist({
    stack: roleStack,
    failure: roleFailure,
    busy,
    roleReady: state.setup.roleReady,
    variablesReady: state.setup.variablesReady,
    saveFailed,
    variablesError,
    reusedOidcProvider,
    driftNote: drift.role
      ? `No stack called ${drift.role.stackName} in ${drift.role.region}.`
      : null,
  });

  /** Where the work actually stands, regardless of what is being looked at. */
  const nextUnfinished = ORDER.find((id) => !done[id]) ?? FINAL_STEP;
  const current = chosen ?? nextUnfinished;
  const index = ORDER.indexOf(current);
  const step = STEP_META[current];

  async function post(stepId: BusyKey, url: string, payload?: unknown) {
    setBusy(stepId);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload ?? {}),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error ?? "That step failed");
      return body as Record<string, unknown>;
    } catch (err) {
      setError(err instanceof Error ? err.message : "That step failed");
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function patch(stepId: BusyKey, payload: unknown, message: string) {
    setBusy(stepId);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch(`/api/projects/${projectId}/deploy`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error ?? "Failed to save");
      setNotice(message);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setBusy(null);
    }
  }

  async function applyStack(stack: "role" | "state", stepId: BusyKey) {
    if (stack === "role") {
      setRoleFailure(null);
      setVariablesError(null);
    }

    const body = await post(
      stepId,
      `/api/projects/${projectId}/deploy/bootstrap`,
      {
        action: "apply",
        stack,
        ...(stack === "role" && reuseOidc ? { createOidcProvider: false } : {}),
      },
    );
    if (!body) return;

    const next = (body.stack as StackDto | null) ?? null;
    if (stack === "role") {
      lastRoleStack.current = next;
      setRoleStack(next);
    } else setStateStack(next);

    if (stack === "role") {
      // Reported on the checklist line it belongs to. "CloudFormation is building
      // the stack" was a banner restating the spinner directly beneath it.
      setReusedOidcProvider(Boolean(body.reusedOidcProvider));
    } else {
      setNotice(
        body.started
          ? "CloudFormation is building the stack."
          : "The stack was already up to date.",
      );
    }

    await onChanged();
  }

  async function adoptStack(stack: "role" | "state", stepId: BusyKey) {
    const body = await post(
      stepId,
      `/api/projects/${projectId}/deploy/bootstrap`,
      { action: "adopt", stack },
    );
    if (!body) return;

    const github = body.github as { written?: boolean; error?: string } | null;
    setNotice(
      github?.written
        ? "Saved, and written to the repository's Actions variables."
        : `Saved. ${github?.error ?? ""}`.trim(),
    );
    await onChanged();
  }

  async function writePipeline() {
    const body = await post(
      "pipeline",
      `/api/projects/${projectId}/deploy/pipeline`,
    );
    if (!body) return;

    const commit = body.commit as { sha: string; paths: string[] } | null;
    setNotice(
      commit
        ? `Committed ${commit.paths.length} file(s) as ${commit.sha.slice(0, 7)}.`
        : "The workflows were already up to date.",
    );
    await onChanged();
  }

  const templates = state.templates;

  function setTemplateConfig(patchBody: Record<string, unknown>) {
    void patch(
      "pipeline",
      { templates: { ...templates.config, ...patchBody } },
      "Template settings saved.",
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="gap-4 pb-4">
          <CardTitle className="text-base">Set up deployment</CardTitle>

          <WizardSteps
            current={current}
            label="Deployment setup steps"
            onSelect={setChosen}
            steps={ORDER.map((id) => ({
              id,
              label: STEP_META[id].label,
              done: done[id],
              // Finished steps, plus the step the work has actually reached. One
              // whose prerequisite is missing would only show a disabled button
              // and a sentence saying why.
              enabled: done[id] || id === nextUnfinished || id === current,
            }))}
          />
        </CardHeader>

        {/* A floor under the body, so the card is the same size on every step.
            Without it the box shrank to the two controls of the role step and
            grew again on the workflows step, and on a narrow window the
            appearing scrollbar moved the whole card sideways as it did. */}
        <CardContent className="min-h-80 space-y-4 border-t pt-4">
          <div>
            <h3 className="flex items-center gap-2 font-semibold text-base">
              <step.icon className="h-4 w-4 shrink-0 text-muted-foreground" />
              {step.title}
            </h3>
            {step.description ? (
              <p className="text-muted-foreground text-sm">
                {step.description}
              </p>
            ) : null}
          </div>

          {error ? (
            <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              {error}
            </p>
          ) : null}
          {notice ? (
            <p className="flex items-start gap-2 rounded-lg border bg-muted/50 px-3 py-2 text-sm">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
              {notice}
            </p>
          ) : null}

          {current === "account" ? (
            // Explicitly three-way: until the bootstrap read answers, whether
            // this step is a sign-in or a region is not yet known, and guessing
            // showed the region picker for a second to people with no account.
            connection === null ? (
              <Skeleton className="h-24 w-full max-w-sm" />
            ) : !connection.connected ? (
              // The sign-in itself, rather than a link to it. Signing in *is*
              // step one, and sending people to another screen to do it left
              // the wizard starting at a step it could not perform.
              //
              // The server's reason for it ("this project has no AWS account
              // yet…") is not printed: the form underneath is the answer to it,
              // and naming the tab you are already on explained nothing.
              <AwsSsoConnect
                onConnected={(created) => void connectAccount(created)}
                usesSessionOnly
              />
            ) : (
              <div className="space-y-3">
                <div className="grid max-w-sm gap-2">
                  <Label htmlFor="wizard-region">Region</Label>
                  {/* Saved as it is picked, rather than behind a Save button:
                      this is one select, the next step creates a role and a
                      bucket in whatever it says, and a region left unsaved
                      looked exactly like a region that was set. */}
                  <AwsRegionPicker
                    disabled={busy !== null}
                    onChange={(next) => {
                      setRegion(next);
                      if (next.trim() === state.settings.awsRegion) return;
                      void patch(
                        "account",
                        { awsRegion: next.trim() },
                        "Region saved.",
                      );
                    }}
                    triggerId="wizard-region"
                    value={region}
                  />
                </div>
                {/* The sentence that used to sit here explained what the region
                    decides. The next two steps show it being decided — a role
                    and a bucket appearing in that region — so it was a caption
                    for something the user was about to watch happen. Only the
                    save feedback is left, because a select that saves itself
                    otherwise gives no sign that it did. */}
                {busy === "account" ? (
                  <p className="flex items-center gap-2 text-muted-foreground text-xs">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Saving the region…
                  </p>
                ) : null}
              </div>
            )
          ) : null}

          {current === "role" ? (
            <div className="space-y-3">
              {/* Only while the permissions are still a decision. Once the stack
                  has been asked for, what the role may do is settled, and after
                  it exists the warning is a fact about the finished setup — which
                  is where the configuration view states it, in full, next to the
                  account number it applies to. Here it was competing with the
                  progress and then outliving its own usefulness. */}
              {drift.role ? (
                <DriftNotice
                  busy={busy === "role"}
                  drift={drift.role}
                  kind="role"
                  onForget={() => void forgetSetup("role")}
                />
              ) : null}

              {roleStack === null &&
              !roleRunning &&
              !roleFailed &&
              !drift.role ? (
                <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
                  <ShieldAlert className="h-4 w-4 shrink-0 text-amber-600" />
                  <p className="font-medium">
                    The role gets AdministratorAccess.
                  </p>
                </div>
              ) : null}

              <StepChecklist items={roleChecklist} />

              {roleFailure ? (
                <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-destructive text-xs">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {roleFailure}
                </p>
              ) : null}

              {roleStack?.statusReason && roleFailed ? (
                <p className="text-muted-foreground text-xs">
                  {roleStack.statusReason}
                </p>
              ) : null}

              {/* An account can hold only one provider per URL. The server works
                  that out by asking IAM, so this is the escape hatch for a
                  session that may not list providers — not the normal path. */}
              {roleFailed ? (
                <label className="flex items-start gap-2 text-muted-foreground text-xs">
                  <input
                    checked={reuseOidc}
                    className="mt-0.5"
                    onChange={(event) => setReuseOidc(event.target.checked)}
                    type="checkbox"
                  />
                  This account already trusts GitHub — reuse the existing
                  identity provider instead of creating it.
                </label>
              ) : null}

              {/* One control, and only where there is something to press. While
                  it runs the checklist is the status, so a disabled button with a
                  spinner in it said nothing the list did not. When it is finished
                  there is nothing to ask for — rebuilding is below, quietly,
                  because it is what you want after changing the branch or the
                  repository and never what you want on first arrival. */}
              {/* A create that cannot succeed is worse than no button: it fails on
                  a name already taken, and `OnFailure: DELETE` then removes the
                  stack it just made, so pressing it twice looks like the wizard
                  resetting itself. The notice above says what to do instead. */}
              {drift.role
                ?.collides ? null : roleRunning ? null : roleStack?.succeeded ? (
                <Button
                  className="text-muted-foreground"
                  disabled={busy !== null || building}
                  onClick={() => void applyStack("role", "role")}
                  size="sm"
                  variant="ghost"
                >
                  <Rocket className="mr-2 h-3.5 w-3.5" />
                  Rebuild the stack
                </Button>
              ) : (
                <Button
                  disabled={busy !== null || building}
                  onClick={() => void applyStack("role", "role")}
                  size="sm"
                >
                  <Rocket className="mr-2 h-3.5 w-3.5" />
                  {roleFailed ? "Try again" : "Create"}
                </Button>
              )}

              {/* The Actions variables are written for you once the stack has
                  finished — see `saveRole`. Only a failure needs a control, and
                  the checklist line above has already said which part failed.
                  Two failures reach here: the whole save threw (`saveFailed`), or
                  it worked except for the repository (`variablesError`). The
                  second one used to fall through to the stack's own button, which
                  offered to rebuild a role that was never the problem. */}
              {!roleRunning && (saveFailed || variablesError !== null) ? (
                <Button
                  disabled={busy !== null}
                  onClick={() => void saveRole()}
                  size="sm"
                  variant="outline"
                >
                  Try saving the role again
                </Button>
              ) : null}
            </div>
          ) : null}

          {current === "state" ? (
            <div className="space-y-3">
              <p className="text-muted-foreground text-xs">
                Its own stack, because deleting state does not delete the
                infrastructure it tracks — it only makes Terraform forget about
                it. Everything here is set to retain, so removing the role stack
                later cannot take the state with it.
              </p>

              <dl className="grid gap-1 text-xs sm:grid-cols-[10rem_1fr]">
                <dt className="text-muted-foreground">Bucket</dt>
                <dd className="truncate font-mono">
                  {state.settings.stateBucket ?? "named for you when it runs"}
                </dd>
                <dt className="text-muted-foreground">Lock table</dt>
                <dd className="truncate font-mono">
                  {state.settings.stateLockTable ??
                    "named for you when it runs"}
                </dd>
                <dt className="text-muted-foreground">Encryption key</dt>
                <dd className="break-all font-mono">
                  {state.settings.stateKmsKeyArn ??
                    "a new KMS key, created by this stack"}
                </dd>
              </dl>

              <p className="text-muted-foreground text-xs">
                The key is what lets the State tab show your resources: reading
                the state needs{" "}
                <code className="rounded bg-muted px-1">kms:Decrypt</code> on
                it, and TerraBlox asks for a session scoped to that one object
                and that one key.
              </p>

              {drift.state ? (
                <DriftNotice
                  busy={busy === "state"}
                  drift={drift.state}
                  kind="state"
                  onForget={() => void forgetSetup("state")}
                />
              ) : null}

              {drift.state?.collides ? null : (
                <StackControls
                  busy={busy === "state"}
                  disabled={busy !== null || building || !state.setup.roleReady}
                  onRun={() => void applyStack("state", "state")}
                  stack={stateStack}
                />
              )}

              {state.setup.roleReady ? null : (
                <p className="text-muted-foreground text-xs">
                  The role has to exist first — the key grants it access by
                  name.
                </p>
              )}

              {stateStack?.succeeded && !done.state ? (
                <Button
                  disabled={busy !== null}
                  onClick={() => void adoptStack("state", "state")}
                  size="sm"
                  variant="outline"
                >
                  {busy === "state" ? (
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  ) : null}
                  Use its outputs
                </Button>
              ) : null}
            </div>
          ) : null}

          {current === "pipeline" ? (
            <div className="space-y-4">
              <ul className="space-y-2">
                {templates.catalogue.map((template) => (
                  <li key={template.id}>
                    <ToggleRow
                      description={
                        <>
                          {template.summary}
                          {template.requires ? (
                            <> Needs {template.requires}.</>
                          ) : null}
                          <span className="mt-0.5 block font-mono text-[11px]">
                            {template.path}
                          </span>
                        </>
                      }
                      disabled={template.required || busy !== null}
                      hint={template.required ? "required" : undefined}
                      label={template.name}
                      on={template.enabled}
                      onToggle={() => {
                        const disabled = new Set(templates.config.disabled);
                        if (template.enabled) disabled.add(template.id);
                        else disabled.delete(template.id);
                        setTemplateConfig({ disabled: [...disabled] });
                      }}
                    />
                  </li>
                ))}
              </ul>

              <div className="grid max-w-xs gap-2">
                <Label htmlFor="wizard-tf-version">Terraform version</Label>
                <Input
                  className="font-mono text-sm"
                  defaultValue={templates.config.terraformVersion}
                  id="wizard-tf-version"
                  onBlur={(event) => {
                    const value = event.target.value.trim();
                    if (value === templates.config.terraformVersion) return;
                    setTemplateConfig({ terraformVersion: value });
                  }}
                  placeholder="1.9.8"
                />
              </div>

              <ToggleRow
                description="Apply runs in a GitHub environment called production, so you can require someone to approve it before anything changes in AWS."
                disabled={busy !== null}
                label="Hold apply for an approval"
                on={templates.config.requireApproval}
                onToggle={() =>
                  setTemplateConfig({
                    requireApproval: !templates.config.requireApproval,
                  })
                }
              />

              <ToggleRow
                description="Refresh the cost estimate on a schedule as well as after an apply, since AWS prices move on their own."
                disabled={busy !== null}
                label="Refresh estimates on a schedule"
                on={templates.config.scheduleRefresh}
                onToggle={() =>
                  setTemplateConfig({
                    scheduleRefresh: !templates.config.scheduleRefresh,
                  })
                }
              />

              <Button
                disabled={busy !== null || !state.setup.roleReady}
                onClick={() => void writePipeline()}
              >
                {busy === "pipeline" ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                Commit the workflows
              </Button>
              {state.setup.roleReady ? null : (
                <p className="text-muted-foreground text-xs">
                  Save the role first — the workflows are rendered from it.
                </p>
              )}
            </div>
          ) : null}
        </CardContent>

        {/* Continue only moves through finished steps. The work itself is done
            by the button inside the step, which is what marks it finished. */}
        <div className="flex items-center justify-between border-t p-4">
          <Button
            disabled={index <= 0}
            onClick={() => setChosen(ORDER[index - 1] ?? null)}
            type="button"
            variant="outline"
          >
            <ArrowLeft className="mr-2 h-3.5 w-3.5" />
            Back
          </Button>

          {current === FINAL_STEP ? null : (
            <Button
              disabled={!done[current]}
              onClick={() => setChosen(ORDER[index + 1] ?? null)}
              type="button"
            >
              Continue
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}

/**
 * Says that this project's bootstrap is somewhere it cannot be reached from, and
 * what the way out is.
 *
 * Three cases, and they need different answers — which is the whole reason this is
 * not one sentence. The role in the same account means the region was changed after
 * setup, and because IAM is global the role is still there and its name is still
 * taken: creating again cannot work, so the only remedy is to point the project
 * back. The role in a *different* account can be rebuilt here perfectly well, and
 * the old one is simply no longer ours to manage. The state bucket can never be
 * rebuilt under the same name, because S3 names are global and this one carries the
 * account it was made for.
 *
 * Nothing here offers to delete anything in AWS. Forgetting a pointer is reversible
 * by setting it up again; deleting a state bucket is the one act in this flow that
 * loses the only record of what Terraform built.
 */
function DriftNotice({
  busy,
  drift,
  kind,
  onForget,
}: {
  busy: boolean;
  drift: DriftDto;
  kind: "role" | "state";
  onForget: () => void;
}) {
  const what = kind === "role" ? "deployment role" : "state bucket";
  const elsewhere =
    drift.pointsAtAccount && drift.pointsAtAccount !== drift.accountId
      ? drift.pointsAtAccount
      : null;

  return (
    <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
      <p className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
        <span>
          This project points at a {what} that is not managed from here. It
          expects the stack{" "}
          <code className="rounded bg-muted px-1 font-mono">
            {drift.stackName}
          </code>{" "}
          in {drift.accountId ?? "this account"} / {drift.region}, and there is
          none.
        </span>
      </p>

      <dl className="grid gap-1 pl-6 sm:grid-cols-[7rem_1fr]">
        <dt className="text-muted-foreground">Points at</dt>
        <dd className="break-all font-mono">{drift.pointsAt}</dd>
        {elsewhere ? (
          <>
            <dt className="text-muted-foreground">Which lives in</dt>
            <dd className="font-mono">{elsewhere}</dd>
          </>
        ) : null}
      </dl>

      {/* Deliberately not alarming: in every one of these cases the thing still
          exists and still works. What is broken is only which of them this screen
          can manage. */}
      <p className="pl-6 text-muted-foreground">
        Nothing has been lost. The {what} is still where it was created —{" "}
        {elsewhere
          ? "in the account named above"
          : "this project's region was most likely changed after it was set up"}
        .{" "}
        {drift.collides
          ? kind === "state"
            ? "It cannot be built again under the same name: S3 bucket names are global. Connect the account and region it was created in to manage it from here again."
            : "It cannot be built again here either: IAM roles are account-wide, so that name is already taken. Set this project's region back to reach it again."
          : "You can either connect that account again, or start fresh in this one — the old one stays untouched."}
      </p>

      {drift.collides ? null : (
        <div className="pl-6">
          <Button
            disabled={busy}
            onClick={onForget}
            size="sm"
            variant="outline"
          >
            {busy ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : null}
            Start fresh in this account
          </Button>
        </div>
      )}
    </div>
  );
}

function ChecklistIcon({ state }: { state: ChecklistState }) {
  if (state === "done") {
    return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />;
  }
  if (state === "failed") {
    return <XCircle className="h-4 w-4 shrink-0 text-destructive" />;
  }
  if (state === "active") {
    return <Loader2 className="h-4 w-4 shrink-0 animate-spin" />;
  }
  // Not started. A clock rather than an empty circle: it says "this is coming",
  // where an outline reads as "this is off".
  return <Clock className="h-4 w-4 shrink-0 text-muted-foreground" />;
}

/**
 * What a step is going to do, ticked off as it does it.
 *
 * Written out before anything runs, in grey, because that is the part a single
 * status line could never show: `CREATE_COMPLETE` next to a spinner told the
 * reader that something had finished without ever having said what was going to
 * happen, or how much of it was left. The same three lines then carry the
 * progress, so watching the step and reading what it did are the same act.
 *
 * Every line is derived from state the server actually reports. Nothing here is
 * on a timer or advanced optimistically — a tick means the thing was read back.
 */
function StepChecklist({ items }: { items: ChecklistItem[] }) {
  return (
    <ol className="space-y-1.5">
      {items.map((item) => (
        <li
          className="flex items-start gap-2 rounded-md border px-3 py-2 text-sm"
          key={item.id}
        >
          <span className="mt-0.5">
            <ChecklistIcon state={item.state} />
          </span>
          <span className="min-w-0">
            <span
              className={
                item.state === "pending" ? "text-muted-foreground" : undefined
              }
            >
              {item.label}
            </span>
            {item.detail ? (
              <span
                className={`mt-0.5 block break-words text-muted-foreground text-xs ${
                  item.mono ? "font-mono" : ""
                }`}
              >
                {item.detail}
              </span>
            ) : null}
            {item.link ? (
              <a
                className="mt-0.5 inline-flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
                href={item.link.href}
                rel="noreferrer"
                target="_blank"
              >
                {item.link.label}
                <ExternalLink className="h-3 w-3 shrink-0" />
              </a>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** CloudFormation's status in a word, for people who do not read its statuses. */
function describeStatus(stack: StackDto): string {
  if (!stack.settled) {
    if (/ROLLBACK/.test(stack.status)) return "Undoing it";
    if (/^DELETE/.test(stack.status)) return "Removing it";
    return "Building";
  }

  return stack.succeeded ? "Done" : "Failed";
}

/** Run-or-rerun plus whatever CloudFormation last said about it. */
function StackControls({
  busy,
  disabled,
  onRun,
  stack,
}: {
  busy: boolean;
  disabled: boolean;
  onRun: () => void;
  stack: StackDto | null;
}) {
  const building = stack !== null && !stack.settled;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={disabled} onClick={onRun} size="sm">
          {busy || building ? (
            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Rocket className="mr-2 h-3.5 w-3.5" />
          )}
          {stack ? "Run it again" : "Create"}
        </Button>
        {stack ? (
          <span className="flex items-center gap-2 text-muted-foreground text-xs">
            {/* CloudFormation's own word for it, next to a plain one. On its own
                `DELETE_IN_PROGRESS` reads as "something is being deleted" with
                no hint that it is this stack undoing itself. */}
            {describeStatus(stack)}
            <span className="font-mono">{stack.status}</span>
          </span>
        ) : null}
      </div>

      {stack?.statusReason && !stack.succeeded ? (
        <p className="text-muted-foreground text-xs">{stack.statusReason}</p>
      ) : null}
    </div>
  );
}
