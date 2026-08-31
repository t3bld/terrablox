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
  FileCode2,
  KeyRound,
  Loader2,
  Lock,
  Plug,
  Rocket,
  ShieldAlert,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { AwsSsoConnect } from "@/components/account/aws-sso-connect";
import { AwsRegionPicker } from "@/components/aws-region-picker";
import { WizardSteps } from "@/components/layout/wizard-steps";
import type { ProjectDeployState } from "@/lib/projects/types";

interface StackDto {
  stackName: string;
  status: string;
  statusReason: string | null;
  settled: boolean;
  succeeded: boolean;
  outputs: Record<string, string>;
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
      setNotice(
        github?.written
          ? "The role is saved, and written to the repository's Actions variables."
          : `The role is saved. ${github?.error ?? ""}`.trim(),
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
    if (stack === "role") setRoleFailure(null);

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

    setNotice(
      body.started
        ? body.reusedOidcProvider
          ? "CloudFormation is building the stack, reusing the GitHub identity provider this account already has."
          : "CloudFormation is building the stack."
        : "The stack was already up to date.",
    );
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
                <p className="flex items-center gap-2 text-muted-foreground text-xs">
                  {busy === "account" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : null}
                  The role, the state bucket and every deployment are created
                  here. Continue when it is right.
                </p>
              </div>
            )
          ) : null}

          {current === "role" ? (
            <div className="space-y-3">
              {/* Only while there is a decision left to make. Once the stack is
                  running, what the role will be allowed to do is settled, and
                  the warning was competing for attention with the status. */}
              {roleRunning ? null : (
                <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
                  <ShieldAlert className="h-4 w-4 shrink-0 text-amber-600" />
                  <p className="font-medium">
                    The role gets AdministratorAccess.
                  </p>
                </div>
              )}

              <StackControls
                busy={busy === "role"}
                disabled={busy !== null || building}
                onRun={() => void applyStack("role", "role")}
                stack={roleStack}
              />

              {roleFailure ? (
                <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-destructive text-xs">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {roleFailure}
                </p>
              ) : null}

              {/* An account can hold only one provider per URL. The server works
                  that out by asking IAM, so this is the escape hatch for a
                  session that may not list providers — not the normal path. */}
              {roleFailure || (roleStack?.settled && !roleStack.succeeded) ? (
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

              {/* The Actions variables are written for you once the stack has
                  finished — see `saveRole`. They were three rows saying "not
                  set" and a button, which asked the user to press a thing that
                  had no decision in it. Only a failure is worth surfacing. */}
              {busy === "role-variables" ? (
                <p className="flex items-center gap-2 text-muted-foreground text-xs">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Writing the role into the repository's Actions variables…
                </p>
              ) : saveFailed ? (
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

              <StackControls
                busy={busy === "state"}
                disabled={busy !== null || building || !state.setup.roleReady}
                onRun={() => void applyStack("state", "state")}
                stack={stateStack}
              />

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
