"use client";

import { Button } from "@terrablox/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@terrablox/ui/card";
import { Label } from "@terrablox/ui/label";
import { Skeleton } from "@terrablox/ui/skeleton";
import { useToast } from "@terrablox/ui/toast";
import { ToggleRow } from "@terrablox/ui/toggle-row";
import { WizardSteps } from "@terrablox/ui/wizard-steps";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Clock,
  Database,
  ExternalLink,
  FileCode2,
  KeyRound,
  Loader2,
  Plug,
  Rocket,
  ShieldAlert,
  Trash2,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AwsSsoConnect } from "@/components/account/aws-sso-connect";
import { AwsRegionPicker } from "@/components/aws-region-picker";
import {
  DEPLOY_PERMISSIONS_POLICY_ARN,
  GITHUB_OIDC_PROVIDER,
} from "@/lib/projects/deploy";
import {
  buildPrivateModulesChecklist,
  buildRoleChecklist,
  buildStateChecklist,
  type ChecklistItem,
  type ChecklistState,
} from "@/lib/projects/deploy-checklist";
import {
  type BootstrapDrift,
  type BootstrapStack,
  type BusyKey,
  deployStepsView,
  FINAL_STEP,
  ORDER,
  type StepId,
} from "@/lib/projects/deploy-steps";
import type { ProjectDeployState } from "@/lib/projects/types";

interface DeployWizardProps {
  projectId: string;
  state: ProjectDeployState;
  /** Re-reads the deploy state, because every step changes what the next sees. */
  onChanged: () => void | Promise<void>;
  /**
   * Finalize succeeded, and here is the state it produced.
   *
   * Distinct from {@link onChanged} because finishing is not the same event as
   * changing, and the owner has to be able to tell them apart. `onChanged` fires
   * after every step and means "read again"; this fires once and means "the setup is
   * done" — which is what lets the deploy tab leave the wizard.
   *
   * Without it the tab could only infer completion from a re-read, and that inference
   * was wrong in one case it could not see: somebody who had opened the wizard from
   * the finished configuration was held there by the caller's own "reconfiguring"
   * flag, which no amount of re-reading clears.
   *
   * The state is passed rather than fetched again: the pipeline route computes it
   * after the commit and returns it, so this saves a round trip and removes the
   * window in which the two answers could disagree.
   *
   * Optional — the State tab shows this wizard with nothing to return to.
   */
  onFinalized?: (deploy: ProjectDeployState) => void | Promise<void>;
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
  /** `owner/name`, for the link to the repository's Actions variables. */
  repoFullName?: string | null;
  /** The branch the trust policy is scoped to, shown in the role step. */
  repoBranch?: string | null;
}

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
    title: "Deploy the Terraform state backend",
    // A store rather than a padlock: what this step creates is a bucket, a table
    // and a key, and the padlock read as "this step is locked".
    icon: Database,
  },
  pipeline: {
    label: "Workflows",
    title: "Create CI/CD pipeline",
    icon: FileCode2,
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
  onFinalized,
  onAttach,
  awsAccountId = null,
  repoFullName = null,
  repoBranch = null,
}: DeployWizardProps) {
  const toast = useToast();
  const [roleStack, setRoleStack] = useState<BootstrapStack | null>(null);
  const [stateStack, setStateStack] = useState<BootstrapStack | null>(null);
  /** The state of the provider the role's trust names. Null = could not tell. */
  const [oidcProvider, setOidcProvider] = useState<
    "ready" | "missing" | "wrong-audience" | null
  >(null);
  const [drift, setDrift] = useState<{
    role: BootstrapDrift | null;
    state: BootstrapDrift | null;
  }>({ role: null, state: null });
  /**
   * What was already done when the current run started, per step.
   *
   * Captured because the checklist answers two questions with one tick. Its job is
   * to report the current state, which is what somebody opening the wizard cold
   * needs; during a rebuild the same list is read as progress, and a line that was
   * green before the click looks like a step this run skipped.
   *
   * Null means no run has been started from this screen, so every tick is simply
   * the state — which is the right reading before anybody presses anything. Cleared
   * again whenever the state genuinely changes underneath: a delete or a forget
   * makes the previous baseline a statement about a setup that no longer exists.
   */
  const [runBaseline, setRunBaseline] = useState<{
    role: { record: boolean; variables: boolean } | null;
    state: { record: boolean; variables: boolean } | null;
  }>({ role: null, state: null });
  const [connection, setConnection] = useState<{
    connected: boolean;
    message: string | null;
  } | null>(null);
  const [busy, setBusy] = useState<BusyKey | null>(null);
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
  /** The same, for the state step's own save. Separate so one retry is one step. */
  const [stateSaveFailed, setStateSaveFailed] = useState(false);
  /** Which stack's Delete has been pressed once and is waiting for the second. */
  const [confirmingDelete, setConfirmingDelete] = useState<
    "role" | "state" | null
  >(null);

  /**
   * A stack this tab asked CloudFormation to delete, until it has gone.
   *
   * Held here rather than on the project because deleting clears the project's
   * pointer to it in the same request — which is what lets the step offer a fresh
   * create under the current naming afterwards, and what stops the drift check from
   * reporting a deliberate deletion as a stack that went missing. The cost is that
   * the name only lives as long as this tab: after a reload the step reads as "not
   * set up", which is true, and a create started too early is refused by
   * CloudFormation with its own message rather than silently colliding.
   */
  const [deleting, setDeleting] = useState<{
    role?: string;
    state?: string;
  }>({});

  /**
   * The same names, for `readStacks`, whose identity has to stay stable.
   *
   * One entry per stack rather than one entry in total. They were a single slot,
   * which made tearing a project down impossible: deleting the role and then the
   * state overwrote the name still being waited on, so the first deletion was never
   * seen to finish. The two stacks are deliberately independent — that is the whole
   * reason there are two — and the UI has to be able to hold both at once.
   */
  const deletingRef = useRef<{ role?: string; state?: string }>({});
  /**
   * Why the Actions variables were not written, when the rest of the save worked.
   *
   * Its own field rather than part of `error`: the role *is* saved at that point,
   * so a banner saying something failed would overstate it. It belongs to the one
   * checklist line it is about.
   */
  const [variablesError, setVariablesError] = useState<string | null>(null);
  /**
   * Why the last role stack attempt did not survive.
   *
   * Kept separately from `error` because it has to outlive the stack it came
   * from: a create that fails is deleted again, so a poll or two later there is
   * nothing left to describe and the reason would vanish with it.
   */
  const [roleFailure, setRoleFailure] = useState<string | null>(null);

  /**
   * Why the last state stack attempt did not survive.
   *
   * The counterpart of `roleFailure`, and it was missing — which is how a state
   * step could look like it did nothing at all. `OnFailure: DELETE` removes a stack
   * that failed to create, so a poll or two later there is nothing left to describe:
   * no stack, no status, no reason. The button came back and the user had watched a
   * create fail without being told.
   */
  const [stateFailure, setStateFailure] = useState<string | null>(null);

  /** Each stack as the previous read saw it, to notice it disappearing. */
  const lastRoleStack = useRef<BootstrapStack | null>(null);
  const lastStateStack = useRef<BootstrapStack | null>(null);

  const readStacks = useCallback(async () => {
    try {
      const waitingFor = deletingRef.current;
      const query = new URLSearchParams();
      for (const name of [waitingFor.role, waitingFor.state]) {
        if (name) query.append("deleting", name);
      }
      const response = await fetch(
        `/api/projects/${projectId}/deploy/bootstrap${
          query.size ? `?${query}` : ""
        }`,
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error ?? "Failed to read");

      const connected = Boolean(body.connected);
      setConnection({ connected, message: body.message ?? null });

      /**
       * Nothing below may be read as news about AWS unless AWS was reached.
       *
       * A read without a session answers `role: null, state: null` — the same
       * shape as "no such stack". Taken at face value that is two wrong
       * conclusions: a deletion still in progress looks finished, and a stack
       * that was building looks rolled back and removed. Both are indistinguishable
       * from the truth by shape alone, which is why the flag has to gate them
       * rather than the values.
       */
      if (!connected) return;

      // A stack we took down has stopped answering, so it is gone. Only then is
      // its step allowed to offer a create again. Checked per stack: the other one
      // may still be deleting, and clearing both would offer a create against a
      // name CloudFormation is still removing.
      const stillThere = new Set(
        Array.isArray(body.deleting)
          ? (body.deleting as unknown[]).filter(
              (name): name is string => typeof name === "string",
            )
          : [],
      );
      const gone = (["role", "state"] as const).filter((which) => {
        const name = waitingFor[which];
        return name !== undefined && !stillThere.has(name);
      });

      if (gone.length) {
        const next = { ...deletingRef.current };
        for (const which of gone) delete next[which];
        deletingRef.current = next;
        setDeleting(next);
      }

      const role = (body.role as BootstrapStack | null) ?? null;
      const previous = lastRoleStack.current;
      lastRoleStack.current = role;

      if (role?.succeeded) setRoleFailure(null);
      // `waitingFor`, not the ref: the block above has already cleared whatever
      // finished during this poll, and a deletion we asked for must not be read as
      // a stack that fell over. It reported itself as
      // "CloudFormation rolled the stack back and removed it (DELETE_IN_PROGRESS)",
      // which is the one status that says the opposite — it was doing as it was told.
      else if (
        previous &&
        !role &&
        !previous.succeeded &&
        waitingFor.role === undefined
      ) {
        // The stack was rolled back and removed under us. Keep what it said, or
        // the wizard resets to a fresh "Create" button with no hint of why.
        setRoleFailure(
          previous.statusReason ??
            `CloudFormation rolled the stack back and removed it (${previous.status}).`,
        );
      }

      setRoleStack(role);

      // The same reasoning for the state stack, which had none. Its resources are
      // set to retain, so the usual reason a re-create fails is that the bucket the
      // last one left behind is still there — a failure that erases its own stack
      // and, without this, its own explanation.
      const stateStackNow = (body.state as BootstrapStack | null) ?? null;
      const previousState = lastStateStack.current;
      lastStateStack.current = stateStackNow;

      if (stateStackNow?.succeeded) setStateFailure(null);
      else if (
        previousState &&
        !stateStackNow &&
        !previousState.succeeded &&
        waitingFor.state === undefined
      ) {
        setStateFailure(
          previousState.statusReason ??
            `CloudFormation rolled the stack back and removed it (${previousState.status}).`,
        );
      }

      setStateStack(stateStackNow);

      setOidcProvider(
        body.oidcProvider === "ready" ||
          body.oidcProvider === "missing" ||
          body.oidcProvider === "wrong-audience"
          ? body.oidcProvider
          : null,
      );

      const reported = body.drift as
        | { role: BootstrapDrift | null; state: BootstrapDrift | null }
        | undefined;
      setDrift({
        role: reported?.role ?? null,
        state: reported?.state ?? null,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to read");
    }
  }, [projectId, toast]);

  /**
   * Re-reads after a step failed, then puts the step's own message back.
   *
   * A session that lapses while nobody is pressing anything is invisible: the
   * wizard polls only while CloudFormation is working, so the first sign of it is
   * one action failing on a step that still claims to be available. Reading again
   * here is what turns that into "you are on step one", instead of leaving a
   * finished-looking wizard whose next button fails the same way.
   *
   * The message is restored last because `readStacks` sets its own on failure, and
   * "the role could not be created" is more use than "failed to read".
   */
  const revalidate = useCallback(
    async (message: string) => {
      await readStacks();
      toast.error(message);
    },
    [readStacks, toast],
  );

  // Coming back to the tab is when an expiry has usually just happened, and it is
  // the one moment a check costs nothing anybody notices. Cheaper than polling on
  // a timer, and it covers the case the user actually hit: leave, come back, find
  // the wizard still offering steps it can no longer perform.
  useEffect(() => {
    const recheck = () => void readStacks();
    window.addEventListener("focus", recheck);
    return () => window.removeEventListener("focus", recheck);
  }, [readStacks]);

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

  /**
   * Takes what the role stack produced and records it: the ARN and account id on
   * the project, and the Actions variables in the repository.
   *
   * Not built on `post` so it can be a stable callback for the effect below, and
   * so a failure can be remembered rather than only shown.
   */
  const saveRole = useCallback(async () => {
    setBusy("role-variables");

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
      await revalidate(
        err instanceof Error ? err.message : "Could not save the role.",
      );
      setSaveFailed(true);
    } finally {
      setBusy(null);
    }
  }, [projectId, onChanged, revalidate]);

  /**
   * One attempt per stack outcome, tracked in a ref rather than in state.
   *
   * Without it the effect would re-fire on the render its own state change causes
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
   * Records what the state stack produced: the bucket and the key
   * on the project, and the bucket in the repository's Actions variables.
   *
   * The counterpart of {@link saveRole}, and it exists for the same reason. This
   * used to be a button labelled "Use its outputs", which asked the user to
   * confirm that a stack they had just watched succeed should be believed. Nothing
   * about it was a decision: there is one right answer and no other option.
   */
  const saveState = useCallback(async () => {
    setBusy("state");

    try {
      const response = await fetch(
        `/api/projects/${projectId}/deploy/bootstrap`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "adopt", stack: "state" }),
        },
      );
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body?.error ?? "Could not save the state backend.");
      }

      const github = body.github as {
        written?: boolean;
        error?: string;
      } | null;
      setVariablesError(
        github?.written
          ? null
          : (github?.error ??
              "Could not write the repository's Actions variables."),
      );
      setStateSaveFailed(false);
      await onChanged();
    } catch (err) {
      await revalidate(
        err instanceof Error
          ? err.message
          : "Could not save the state backend.",
      );
      setStateSaveFailed(true);
    } finally {
      setBusy(null);
    }
  }, [projectId, onChanged, revalidate]);

  /** Its own attempt marker, so one step's retry does not consume the other's. */
  const autoSavedState = useRef<string | null>(null);

  useEffect(() => {
    if (!stateStack?.succeeded) return;
    if (state.setup.stateReady && state.setup.variablesReady) return;

    const attempt = `${stateStack.stackName}:${stateStack.status}`;
    if (autoSavedState.current === attempt) return;
    autoSavedState.current = attempt;

    void saveState();
  }, [
    stateStack,
    state.setup.stateReady,
    state.setup.variablesReady,
    saveState,
  ]);

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
    // Reset clears both steps' pointers, so neither baseline describes anything
    // that is still true.
    setRunBaseline({ role: null, state: null });
    await readStacks();
    await onChanged();
  }

  /** Attaches the account signed in to in step one, then re-reads the stacks. */
  const connectAccount = useCallback(
    async (created: { accountId: string | null }) => {
      if (!created.accountId) {
        toast.error("That sign-in did not report an account id.");
        return;
      }

      setBusy("account");

      try {
        await onAttach(created.accountId);
        await readStacks();
        await onChanged();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Could not attach that account.",
        );
      } finally {
        setBusy(null);
      }
    },
    [onAttach, readStacks, onChanged, toast],
  );

  const {
    done,
    current,
    index,
    nextUnfinished,
    awsLost,
    hadProgress,
    roleBusy,
    stateBusy,
    building,
    roleDeleting,
    stateDeleting,
    roleRunning,
    roleFailed,
    stateRunning,
    stateFailed,
  } = deployStepsView({
    connection,
    setup: state.setup,
    chosen,
    busy,
    roleStack,
    stateStack,
    deleting,
    roleFailure,
    stateFailure,
  });

  // Polls while CloudFormation is still moving. Placed after the derivation
  // because `building` is one of its outputs, and a stack that is settling is the
  // only reason this component re-renders without anybody touching it.
  useEffect(() => {
    if (!building) return;
    const timer = setInterval(() => void readStacks(), 5000);
    return () => clearInterval(timer);
  }, [building, readStacks]);

  const roleChecklist = buildRoleChecklist({
    stack: roleStack,
    failure: roleFailure,
    busy,
    roleReady: state.setup.roleReady,
    variablesReady: state.setup.variablesReady,
    saveFailed,
    variablesError,
    oidcProvider,
    repoFullName,
    driftNote: drift.role
      ? `No stack called ${drift.role.stackName} in ${drift.role.region}.`
      : null,
    // `&&` with the current flag on purpose: a line that was done before the run
    // and is *not* done now has changed, and calling that unchanged would be wrong.
    recordUnchanged: runBaseline.role?.record === true && state.setup.roleReady,
    variablesUnchanged:
      runBaseline.role?.variables === true && state.setup.variablesReady,
  });

  const stateChecklist = buildStateChecklist({
    stack: stateStack,
    failure: stateFailure,
    busy,
    stateReady: state.setup.stateReady,
    variablesReady: state.setup.variablesReady,
    saveFailed: stateSaveFailed,
    variablesError,
    bucket: state.settings.stateBucket,
    repoFullName,
    driftNote: drift.state
      ? `No stack called ${drift.state.stackName} in ${drift.state.region}.`
      : null,
    recordUnchanged:
      runBaseline.state?.record === true && state.setup.stateReady,
    variablesUnchanged:
      runBaseline.state?.variables === true && state.setup.variablesReady,
  });

  // Never blocks finishing: Terrablox cannot see secrets, so it cannot check.
  const privateModulesChecklist = buildPrivateModulesChecklist({
    // Without a bound repository there is no pipeline to add a secret to.
    modules: repoFullName ? (state.privateModules ?? []) : [],
    repoFullName: repoFullName ?? "",
  });

  /**
   * Moves to a step, and drops any half-pressed Delete on the way out.
   *
   * The reset belongs here rather than in an effect watching the step: coming back
   * to a button that already reads "Delete the stack" would turn the next click
   * into a deletion nobody started.
   */
  const goToStep = useCallback((id: StepId | null) => {
    setConfirmingDelete(null);
    setChosen(id);
  }, []);
  const step = STEP_META[current];

  async function post(stepId: BusyKey, url: string, payload?: unknown) {
    setBusy(stepId);

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
      await revalidate(err instanceof Error ? err.message : "That step failed");
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function patch(stepId: BusyKey, payload: unknown, message: string) {
    setBusy(stepId);

    try {
      const response = await fetch(`/api/projects/${projectId}/deploy`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error ?? "Failed to save");
      toast.success(message);
      await onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setBusy(null);
    }
  }

  async function applyStack(stack: "role" | "state", stepId: BusyKey) {
    // Read before anything runs: afterwards these flags are the outcome, and the
    // question this answers is what they were beforehand.
    setRunBaseline((current) => ({
      ...current,
      [stack]: {
        record:
          stack === "role" ? state.setup.roleReady : state.setup.stateReady,
        variables: state.setup.variablesReady,
      },
    }));

    if (stack === "role") {
      setRoleFailure(null);
      setVariablesError(null);
    } else setStateFailure(null);

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

    const next = (body.stack as BootstrapStack | null) ?? null;
    if (stack === "role") {
      lastRoleStack.current = next;
      setRoleStack(next);
    } else setStateStack(next);

    await onChanged();
  }

  /**
   * Deletes the stack in AWS and forgets it here, so the step starts over.
   *
   * Two presses, not a dialog. The reason to confirm at all is that this reaches
   * into the user's account and takes something down; the reason not to open a
   * modal is that the thing it removes is recreatable by the button next to it.
   * The second label says what will happen rather than asking whether to.
   */
  async function deleteStack(stack: "role" | "state", stepId: BusyKey) {
    const body = await post(
      stepId,
      `/api/projects/${projectId}/deploy/bootstrap`,
      { action: "delete", stack },
    );
    if (!body) return;

    setConfirmingDelete(null);
    // The baseline described a setup that no longer exists, so keeping it would
    // annotate the next run's ticks with "unchanged" about the wrong thing.
    setRunBaseline((current) => ({ ...current, [stack]: null }));
    if (stack === "role") {
      lastRoleStack.current = null;
      setRoleStack(null);
      setRoleFailure(null);
      setVariablesError(null);
      setSaveFailed(false);
    } else {
      lastStateStack.current = null;
      setStateStack(null);
      setStateFailure(null);
    }

    // No banner: the step itself says it is deleting, and a notice on top of that
    // was two versions of one fact, one of which needed dismissing.
    const stackName =
      typeof body.stackName === "string" ? body.stackName : null;
    if (stackName) {
      const next = { ...deletingRef.current, [stack]: stackName };
      deletingRef.current = next;
      setDeleting(next);
    }

    await onChanged();
    await readStacks();
  }

  async function writePipeline() {
    const body = await post(
      "pipeline",
      `/api/projects/${projectId}/deploy/pipeline`,
    );
    if (!body) return;

    const commit = body.commit as { sha: string; paths: string[] } | null;
    toast.success(
      commit
        ? `Committed ${commit.paths.length} file(s) as ${commit.sha.slice(0, 7)}.`
        : "The workflows were already up to date.",
    );

    // The route answers with the state it computed after the commit, so the caller
    // gets the finished setup straight from the response instead of asking for it
    // again. `onChanged` remains the fallback for a caller that wants no completion
    // signal, and for the — impossible in practice — case of a route that answered
    // without one.
    const deploy = body.deploy as ProjectDeployState | undefined;

    if (onFinalized && deploy) {
      await onFinalized(deploy);
      return;
    }

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
            onSelect={goToStep}
            steps={ORDER.map((id) => ({
              id,
              label: STEP_META[id].label,
              done: done[id],
              // Finished steps, plus the step the work has actually reached. One
              // whose prerequisite is missing would only show a disabled button
              // and a sentence saying why.
              //
              // Without a session, nothing but the first one: the others are still
              // marked done, and leaving them selectable would let someone open a
              // finished step and press a button that cannot reach AWS.
              enabled: awsLost
                ? id === "account"
                : done[id] || id === nextUnfinished || id === current,
            }))}
          />
        </CardHeader>

        {/* A floor under the body, so the card is the same size on every step.
            Without it the box shrank to the two controls of the role step and
            grew again on the workflows step, and on a narrow window the
            appearing scrollbar moved the whole card sideways as it did. */}
        <CardContent className="min-h-80 space-y-4 border-t pt-4">
          <div>
            {/* Smaller than the card's own title, and an h4 under its h3. Both
                used to be `font-semibold text-base` on sibling h3s, so "Connect
                the AWS account" competed with "Set up deployment" instead of
                sitting under it — visually and in the heading outline. */}
            <h4 className="flex items-center gap-2 font-semibold text-sm">
              <step.icon className="h-4 w-4 shrink-0 text-muted-foreground" />
              {step.title}
            </h4>
            {step.description ? (
              <p className="text-muted-foreground text-sm">
                {step.description}
              </p>
            ) : null}
          </div>

          {/* Outcomes are announced in the snackbar now. What stays on this card
              is only what remains true until something changes: a stack that failed
              and its reason, a missing prerequisite, a drift report. */}

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
              <div className="space-y-3">
                {/* Except when the project had already got somewhere. Then the
                    reader is not starting, they have been sent back — and the
                    question that needs answering before they will sign in again
                    is whether the work they did is gone. It is not: the role and
                    the bucket are in AWS, and this project still knows their
                    names. Only the session that reaches them has lapsed. */}
                {hadProgress ? (
                  <div className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
                    <p className="flex items-start gap-2 font-medium">
                      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                      The AWS session has expired. Sign in again to carry on.
                    </p>
                    <p className="pl-6 text-muted-foreground">
                      Nothing has been lost.{" "}
                      {state.setup.stateReady
                        ? "The deployment role and the state backend are still in AWS"
                        : "The deployment role is still in AWS"}
                      , and this project still points at them. The later steps
                      are on hold until the connection is back, because none of
                      them can reach AWS without it.
                    </p>
                  </div>
                ) : null}

                <AwsSsoConnect
                  onConnected={(created) => void connectAccount(created)}
                  usesSessionOnly
                />
              </div>
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
            roleDeleting ? (
              <DeletingStack
                stackName={deleting.role ?? roleStack?.stackName ?? null}
                status={roleStack?.status ?? null}
              />
            ) : (
              <div className="space-y-3">
                {/* What the step is about, in the state step's shape. Three of the
                  four rows are known before anything runs, which is the useful
                  part: who will be allowed to assume this role, through which
                  provider, and what it will be able to do — read before agreeing
                  to it rather than looked up afterwards. */}
                <dl className="grid gap-1 text-xs sm:grid-cols-[10rem_1fr]">
                  <dt className="text-muted-foreground">Role</dt>
                  <dd className="break-all font-mono">
                    {state.settings.awsRoleArn ?? "created by this stack"}
                  </dd>
                  <dt className="text-muted-foreground">Assumed by</dt>
                  <dd className="break-all font-mono">
                    {repoFullName
                      ? `${repoFullName} on ${repoBranch ?? "the deployment branch"}`
                      : "this project's repository"}
                  </dd>
                  <dt className="text-muted-foreground">Identity provider</dt>
                  <dd className="break-all font-mono">
                    {GITHUB_OIDC_PROVIDER}
                  </dd>
                  <dt className="text-muted-foreground">Permissions</dt>
                  <dd className="break-all font-mono">
                    {DEPLOY_PERMISSIONS_POLICY_ARN}
                  </dd>
                </dl>

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
                  spinner in it said nothing the list did not.

                  A create that cannot succeed is worse than no button: it fails on a
                  name already taken, and `OnFailure: DELETE` then removes the stack
                  it just made, so pressing it twice looks like the wizard resetting
                  itself. The drift notice above says what to do instead.

                  A deletion needs no case here — the whole step is the waiting
                  indicator while one runs. */}
                {drift.role
                  ?.collides ? null : roleRunning ? null : roleStack?.succeeded ? (
                  // Both outlined rather than filled: the step is finished, and
                  // neither of these is the thing to do next. Rebuild is for after a
                  // branch or repository change; Delete is for starting over.
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      disabled={busy !== null || roleBusy}
                      onClick={() => void applyStack("role", "role")}
                      size="sm"
                      variant="outline"
                    >
                      <Rocket className="mr-2 h-3.5 w-3.5" />
                      Rebuild
                    </Button>

                    <Button
                      disabled={busy !== null || roleBusy}
                      onClick={() =>
                        confirmingDelete === "role"
                          ? void deleteStack("role", "role")
                          : setConfirmingDelete("role")
                      }
                      size="sm"
                      variant="outline"
                    >
                      <Trash2 className="mr-2 h-3.5 w-3.5" />
                      {confirmingDelete === "role"
                        ? "Delete the stack"
                        : "Delete"}
                    </Button>

                    {confirmingDelete === "role" ? (
                      <span className="text-muted-foreground text-xs">
                        Removes the role and its GitHub trust from AWS. Deploys
                        stop working until it is created again.
                      </span>
                    ) : null}
                  </div>
                ) : (
                  <Button
                    disabled={busy !== null || roleBusy}
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
            )
          ) : null}

          {current === "state" ? (
            stateDeleting ? (
              <DeletingStack
                detail="The backend can be created again once CloudFormation has finished. The bucket and its key are set to retain and stay behind."
                stackName={deleting.state ?? stateStack?.stackName ?? null}
                status={stateStack?.status ?? null}
              />
            ) : (
              <div className="space-y-3">
                <dl className="grid gap-1 text-xs sm:grid-cols-[10rem_1fr]">
                  <dt className="text-muted-foreground">Bucket</dt>
                  <dd className="truncate font-mono">
                    {state.settings.stateBucket ?? "named for you when it runs"}
                  </dd>
                  {/* No locking row. It used to name a DynamoDB table, which was a
                      real per-project value; S3 does the locking itself now, so the
                      row said the same sentence in every project — a constant among
                      names and ARNs, which is what this table is for. */}
                  <dt className="text-muted-foreground">Encryption key</dt>
                  <dd className="break-all font-mono">
                    {state.settings.stateKmsKeyArn ??
                      "a new KMS key, created by this stack"}
                  </dd>
                </dl>

                <StepChecklist items={stateChecklist} />

                {/* What the attempt said, kept after the stack that said it was
                    removed. Without this the step reset to a Create button and the
                    failure was invisible — which is what "clicking Create does
                    nothing" actually was. */}
                {stateFailure ? (
                  <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-destructive text-xs">
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{stateFailure}</span>
                  </p>
                ) : null}

                {drift.state ? (
                  <DriftNotice
                    busy={busy === "state"}
                    drift={drift.state}
                    kind="state"
                    onForget={() => void forgetSetup("state")}
                  />
                ) : null}

                {state.setup.roleReady ? null : (
                  <p className="text-muted-foreground text-xs">
                    The role has to exist first — the key grants it access by
                    name.
                  </p>
                )}

                {/* The role step's shape, for the same reasons. The one difference
                  worth knowing is in the confirmation text: this stack's contents
                  are set to retain, so deleting it leaves the bucket behind. */}
                {drift.state
                  ?.collides ? null : stateRunning ? null : stateStack?.succeeded ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      disabled={busy !== null || stateBusy || roleBusy}
                      onClick={() => void applyStack("state", "state")}
                      size="sm"
                      variant="outline"
                    >
                      <Rocket className="mr-2 h-3.5 w-3.5" />
                      Rebuild
                    </Button>

                    <Button
                      disabled={busy !== null || stateBusy}
                      onClick={() =>
                        confirmingDelete === "state"
                          ? void deleteStack("state", "state")
                          : setConfirmingDelete("state")
                      }
                      size="sm"
                      variant="outline"
                    >
                      <Trash2 className="mr-2 h-3.5 w-3.5" />
                      {confirmingDelete === "state"
                        ? "Delete the stack"
                        : "Delete"}
                    </Button>

                    {confirmingDelete === "state" ? (
                      <span className="text-muted-foreground text-xs">
                        Removes the stack only. The bucket and its key are set
                        to retain and stay in AWS, holding the record of what
                        Terraform has built — so creating this backend again
                        under the same name will fail on the bucket that is
                        still there. Delete the bucket in AWS first if you mean
                        to start over.
                      </span>
                    ) : null}
                  </div>
                ) : (
                  <Button
                    disabled={
                      busy !== null ||
                      stateBusy ||
                      roleBusy ||
                      !state.setup.roleReady
                    }
                    onClick={() => void applyStack("state", "state")}
                    size="sm"
                  >
                    <Rocket className="mr-2 h-3.5 w-3.5" />
                    {stateFailed ? "Try again" : "Create"}
                  </Button>
                )}

                {!stateRunning && stateSaveFailed ? (
                  <Button
                    disabled={busy !== null}
                    onClick={() => void saveState()}
                    size="sm"
                    variant="outline"
                  >
                    Try saving the state backend again
                  </Button>
                ) : null}
              </div>
            )
          ) : null}

          {current === "pipeline" ? (
            <div className="space-y-4">
              {/* First, because it applies to every workflow below. Underneath the
                  list it read as a property of whichever one it followed.

                  A list rather than a text field. What goes here ends up verbatim
                  in `setup-terraform`, so a typo used to become a run that failed
                  on a version nobody publishes — after it had already federated
                  into AWS. A version the project pinned before it left the list is
                  kept and shown, so this cannot silently move somebody's pipeline
                  to a different Terraform. */}
              <StepSection id={TF_VERSION_HEADING} title="Terraform version">
                <select
                  // Named by the heading above rather than by a `Label` of its own.
                  // A label would have put the same words on screen twice, or hidden
                  // one of them — and it was the reason this control had a heavier
                  // heading than the section under it.
                  aria-labelledby={TF_VERSION_HEADING}
                  className="h-9 max-w-xs rounded-md border bg-transparent px-3 font-mono text-sm"
                  disabled={busy !== null}
                  onChange={(event) =>
                    setTemplateConfig({ terraformVersion: event.target.value })
                  }
                  value={templates.config.terraformVersion}
                >
                  {(templates.terraformVersions.includes(
                    templates.config.terraformVersion,
                  )
                    ? templates.terraformVersions
                    : [
                        templates.config.terraformVersion,
                        ...templates.terraformVersions,
                      ]
                  ).map((version, index) => (
                    <option key={version} value={version}>
                      {version}
                      {index === 0 && version === templates.terraformVersions[0]
                        ? " (latest)"
                        : ""}
                    </option>
                  ))}
                </select>
              </StepSection>

              <StepSection title="Workflows">
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
              </StepSection>

              {privateModulesChecklist.length > 0 ? (
                <StepSection title="Private module access">
                  <StepChecklist items={privateModulesChecklist} />
                </StepSection>
              ) : null}

              {state.setup.roleReady ? null : (
                <p className="text-muted-foreground text-xs">
                  Save the role first — the workflows are rendered from it.
                </p>
              )}
            </div>
          ) : null}
        </CardContent>

        {/* Continue only moves through finished steps. The work itself is done by
            the button inside the step, which is what marks it finished — except on
            the last one, where the work *is* finishing, so its button takes the
            place Continue occupies everywhere else. */}
        <div className="flex items-center gap-2 border-t p-4">
          {/* Absent on the first step rather than disabled there. It is the first
              step, so there has never been anything behind it: the way out
              backwards is disconnecting the account, which lives on the strip above
              this card. A button that can only ever be grey is furniture. */}
          {index > 0 ? (
            <Button
              onClick={() => goToStep(ORDER[index - 1] ?? null)}
              type="button"
              variant="outline"
            >
              <ArrowLeft className="mr-2 h-3.5 w-3.5" />
              Back
            </Button>
          ) : null}

          {/* `ml-auto` rather than `justify-between` on the row: with Back gone,
              space-between would have pulled this one over to the left. */}
          <div className="ml-auto">
            {current === FINAL_STEP ? (
              <Button
                disabled={busy !== null || !state.setup.roleReady}
                onClick={() => void writePipeline()}
                type="button"
              >
                {busy === "pipeline" ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                Finalize
              </Button>
            ) : (
              <Button
                disabled={!done[current]}
                onClick={() => goToStep(ORDER[index + 1] ?? null)}
                type="button"
              >
                Continue
              </Button>
            )}
          </div>
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
  drift: BootstrapDrift;
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

/**
 * A stack on its way out, and nothing else.
 *
 * It replaces the whole step rather than sitting at the bottom of it. Everything a
 * step shows describes something that exists or is about to: what the role will be
 * allowed to do, which lines of the checklist are done, why the last attempt failed.
 * During a deletion all of it is either about to be untrue or already is — the
 * checklist reads as a half-dismantled success, and the failure banner was reporting
 * the deletion itself as a rollback. One line that says what is happening is the
 * whole of what can honestly be said until CloudFormation is finished.
 */
function DeletingStack({
  detail,
  stackName,
  status,
}: {
  /**
   * What becomes possible once it is gone, where that is worth saying.
   *
   * Optional because it is not always: the role step's version explained that the
   * role's name and the account's GitHub trust stay taken until the deletion
   * finishes, which is true and is not something the reader can act on. The line
   * above already says a stack is being removed.
   */
  detail?: string;
  stackName: string | null;
  /** CloudFormation's own word for it, while it is still describable. */
  status: string | null;
}) {
  return (
    <div className="flex items-start gap-2 text-sm">
      <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
      <div className="min-w-0 space-y-1">
        <p className="flex flex-wrap items-baseline gap-2">
          <span>
            Removing{" "}
            {stackName ? (
              <code className="rounded bg-muted px-1 font-mono text-xs">
                {stackName}
              </code>
            ) : (
              "the stack"
            )}
          </span>
          {status ? (
            <span className="font-mono text-muted-foreground text-xs">
              {status}
            </span>
          ) : null}
        </p>
        {detail ? (
          <p className="text-muted-foreground text-xs">{detail}</p>
        ) : null}
      </div>
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

/** The heading the version picker takes its accessible name from. */
const TF_VERSION_HEADING = "wizard-tf-version-heading";

/**
 * A sub-heading inside a step's card, and whatever sits under it.
 *
 * One component because there were two shapes doing this job: a section heading
 * over the workflow list, and a form `Label` over the version picker. A `Label` is
 * a different element at a different weight, so two groups that are siblings in the
 * same box read as a big one and a small one.
 *
 * `h5` because the card's title is the `h3` and the step's own title the `h4` above
 * it, which keeps the heading order in sequence for a screen reader.
 */
function StepSection({
  id,
  title,
  children,
}: {
  /** Set where a control below needs to point at this heading for its name. */
  id?: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h5
        className="font-medium text-muted-foreground text-xs uppercase tracking-wide"
        id={id}
      >
        {title}
      </h5>
      {children}
    </section>
  );
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
              <span className="mt-0.5 block break-words text-muted-foreground text-xs">
                {item.detail}
              </span>
            ) : null}
            {item.link ? (
              // `flex` rather than `inline-flex`: the label above is inline, so an
              // inline link sat on the same line as it and read as part of the
              // sentence. `w-fit` keeps the hover target the width of the words.
              <a
                className="mt-0.5 flex w-fit items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
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
