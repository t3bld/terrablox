"use client";

import { Button } from "@terrablox/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@terrablox/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@terrablox/ui/dropdown-menu";
import { Skeleton } from "@terrablox/ui/skeleton";
import { useToast } from "@terrablox/ui/toast";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Circle,
  ExternalLink,
  Flame,
  Loader2,
  MoreHorizontal,
  Pencil,
  PlayCircle,
  RefreshCw,
  Rocket,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { PreviousSignIn } from "@/lib/aws/project-connection";
import {
  iamRoleConsoleUrl,
  kmsKeyConsoleUrl,
  s3BucketConsoleUrl,
} from "@/lib/projects/console-links";
import {
  activeRuns,
  blockerFor,
  isRunFromDispatch,
  type PendingDispatch,
} from "@/lib/projects/deploy-runs";
import { showDeployWizard } from "@/lib/projects/deploy-steps";
import type {
  DeployRunKind,
  ProjectDeployState,
  ProjectDto,
  WorkflowRunDto,
  WorkflowTemplateDto,
} from "@/lib/projects/types";
import { AwsReconnectCard } from "./aws-reconnect-card";
import { DeployWizard, WIZARD_COLUMN } from "./deploy-wizard";
import { DestroyRunDialog } from "./destroy-run-dialog";

interface DeployPanelProps {
  projectId: string;
  project: ProjectDto | null;
  /** Passed through to the wizard's first step, which signs in to AWS. */
  onAttachAws: (accountId: string) => Promise<void>;
  /** The connected account, or null. Null reopens the wizard at step one. */
  awsAccountId: string | null;
  /** How the project signed in last, for a one-click sign-in. */
  awsSignIn?: PreviousSignIn | null;
}

/**
 * Everything needed to get the project's Terraform running in CI.
 *
 * Two faces, decided by whether the setup is actually finished: a wizard while
 * anything is still missing, and the configuration plus the run controls once it
 * is not. The old panel showed both at once, which meant the first thing a new
 * project offered was a form with five empty fields and no clue which to fill in
 * first.
 *
 * The pipeline itself lives in the repository as ordinary workflow files, so
 * this panel generates and inspects them rather than hiding them behind a
 * proprietary runner — a project stays deployable without Terrablox.
 */
export function DeployPanel({
  projectId,
  project,
  onAttachAws,
  awsAccountId,
  awsSignIn = null,
}: DeployPanelProps) {
  const toast = useToast();
  const [state, setState] = useState<ProjectDeployState | null>(null);
  const [loading, setLoading] = useState(true);
  /** The workflow whose dispatch request is in flight. */
  const [running, setRunning] = useState<DeployRunKind | null>(null);
  /** A workflow that changes infrastructure, armed and waiting for its second click. */
  const [confirming, setConfirming] = useState<DeployRunKind | null>(null);
  /** The destroy workflow whose confirmation dialog is open. */
  const [destroying, setDestroying] = useState<WorkflowTemplateDto | null>(
    null,
  );
  /**
   * Dispatches GitHub accepted but has not listed yet.
   *
   * GitHub answers a dispatch without the run it creates, and the run shows up
   * in the list a few seconds later. Without these the buttons unlocked in that
   * gap, and a second click queued a second run.
   */
  const [pending, setPending] = useState<PendingDispatch[]>([]);
  const [reconfiguring, setReconfiguring] = useState(false);
  /**
   * Why this panel is empty, when it is.
   *
   * Stays on the page rather than going to the snackbar: with no deploy state
   * there is nothing else to render, so this line is the panel. Outcomes — a run
   * queued, a run refused — are announced instead.
   */
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);

    try {
      const response = await fetch(`/api/projects/${projectId}/deploy`);
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error ?? "Failed to load");

      const deploy = body.deploy as ProjectDeployState;
      setState(deploy);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  // Read again when the account changes too: signing back in attaches the
  // account after this panel loaded, and its config would otherwise keep
  // showing the state from before the sign-in.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `awsAccountId` is the trigger, not an input.
  useEffect(() => {
    void load();
  }, [load, awsAccountId]);

  /**
   * The wizard finished. Take its state and close it.
   *
   * `setReconfiguring(false)` is the point of this handler, and it is the reason the
   * wizard needed a completion signal at all. `showWizard` below is a disjunction, so
   * `reconfiguring` outranks a finished setup: somebody who opened the wizard from the
   * configuration card stayed in it after pressing Finalize, because the flag that put
   * them there was only ever cleared by the "Back to the deployment" button. The
   * setup read as complete, the strip showed every step ticked, and the tab still
   * refused to move — the flag had outlived the thing it was describing.
   *
   * The state comes from the finalize response rather than from a fresh `load()`,
   * which also removes the second round trip and the window where the two reads could
   * disagree about whether the workflows are there.
   */
  const finalized = useCallback((deploy: ProjectDeployState) => {
    setState(deploy);
    setReconfiguring(false);
    setLoadError(null);
  }, []);

  /** Only the run list, so following a job does not re-read the repository. */
  const refreshRuns = useCallback(async () => {
    try {
      const response = await fetch(`/api/projects/${projectId}/deploy/run`);
      if (!response.ok) return;

      const body = (await response.json()) as { runs: WorkflowRunDto[] };
      setState((current) =>
        current ? { ...current, runs: body.runs, runsError: null } : current,
      );
    } catch {
      // A failed poll is not worth an error banner; the next one may work.
    }
  }, [projectId]);

  const runs = state?.runs ?? [];
  const runInFlight = runs.some((run) => run.status !== "completed");

  /** What the setup turned on, in catalogue order: the buttons on this tab. */
  const workflows = (state?.templates.catalogue ?? []).filter(
    (template) => template.enabled,
  );
  /**
   * The ordinary runs, and the ones that remove infrastructure.
   *
   * Apart on purpose. A destroy next to Apply, in the same style, is one slip of
   * the mouse from the button people press every day; at the far end of the
   * row, outlined in red, it is never the one in reach.
   */
  const runWorkflows = workflows.filter((w) => !w.destroysInfrastructure);
  const destroyWorkflows = workflows.filter((w) => w.destroysInfrastructure);

  /** Pending dispatches whose run GitHub has still not listed. */
  const waiting = pending.filter(
    (dispatch) => !runs.some((run) => isRunFromDispatch(run, dispatch)),
  );

  // A dispatch is accounted for once GitHub lists its run, and given up on after
  // a minute, so a run that never appears cannot lock a button for good.
  useEffect(() => {
    if (waiting.length !== pending.length) {
      setPending(waiting);
      return;
    }
    if (pending.length === 0) return;
    const oldest = Math.min(...pending.map((dispatch) => dispatch.at));
    const timeout = setTimeout(
      () =>
        setPending((current) =>
          current.filter((dispatch) => dispatch.at + 60_000 > Date.now()),
        ),
      Math.max(0, oldest + 60_000 - Date.now()),
    );
    return () => clearTimeout(timeout);
  }, [pending, waiting]);

  const blockerOf = (workflow: WorkflowTemplateDto) =>
    blockerFor(workflow, { runs, workflows, pending: waiting });

  // A confirmation left open while a conflicting run starts elsewhere would arm
  // a button that can no longer be used.
  const confirmingBlocked =
    confirming !== null &&
    (() => {
      const workflow = workflows.find((entry) => entry.id === confirming);
      return !workflow || blockerOf(workflow) !== null;
    })();
  useEffect(() => {
    if (confirmingBlocked) setConfirming(null);
  }, [confirmingBlocked]);

  // A run takes minutes, and a status that only updates on reload would send
  // people to the Actions tab anyway. Faster while waiting for a dispatch to
  // appear, since that is a matter of seconds.
  const awaiting = waiting.length > 0;
  useEffect(() => {
    if (!runInFlight && !awaiting) return;

    const timer = setInterval(() => void refreshRuns(), awaiting ? 3000 : 6000);
    return () => clearInterval(timer);
  }, [runInFlight, awaiting, refreshRuns]);

  async function startRun(workflow: WorkflowTemplateDto, confirm?: string) {
    if (running !== null || blockerOf(workflow)) return;

    setRunning(workflow.id as DeployRunKind);

    try {
      const response = await fetch(`/api/projects/${projectId}/deploy/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          confirm === undefined
            ? { workflow: workflow.id }
            : { workflow: workflow.id, confirm },
        ),
      });

      const body = await response.json();
      if (!response.ok) {
        // Refused because a conflicting run is already going: show it rather
        // than only saying so.
        if (response.status === 409 && body?.activeRun) void refreshRuns();
        throw new Error(body?.error ?? "Failed to start the run");
      }

      setPending((current) => [
        ...current,
        { name: workflow.name, at: Date.now() },
      ]);

      toast.success(
        workflow.destroysInfrastructure
          ? `${workflow.name} queued. Its run summary lists what it removes.`
          : workflow.changesInfrastructure
            ? `${workflow.name} queued. It changes AWS as soon as the runner picks it up.`
            : `${workflow.name} queued.`,
      );
      setDestroying(null);

      // GitHub registers the run a moment after accepting the dispatch; the
      // poll above keeps looking until it does.
      void refreshRuns();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to start the run",
      );
    } finally {
      setRunning(null);
      setConfirming(null);
    }
  }

  if (loading) {
    return (
      <div className={WIZARD_COLUMN}>
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  const ready = state !== null && state.missing.length === 0;
  const configured = state?.setup.complete ?? false;
  // The three ways the wizard wins are in `showDeployWizard`, with the reason each one
  // is there. `reconfiguring` outranks a finished setup, which is why `finalized` above
  // has to clear it.
  const showWizard = showDeployWizard({
    configured: state === null ? null : configured,
    reconfiguring,
    awsAccountId: awsAccountId ?? null,
  });

  /** Set up already, and only the AWS session lapsed. */
  const needsSignIn = configured && !awsAccountId && !reconfiguring;

  return (
    <div className={WIZARD_COLUMN}>
      {loadError ? (
        <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          {loadError}
        </p>
      ) : null}

      {/* A finished setup whose session lapsed needs a sign-in, not the setup
          wizard: everything else is still in place. */}
      {showWizard && state && needsSignIn ? (
        <AwsReconnectCard onAttach={onAttachAws} signIn={awsSignIn} />
      ) : null}
      {showWizard && state && !needsSignIn ? (
        <>
          {configured && awsAccountId ? (
            <Button
              onClick={() => setReconfiguring(false)}
              size="sm"
              variant="ghost"
            >
              <ArrowLeft className="mr-2 h-3.5 w-3.5" />
              Back to the deployment
            </Button>
          ) : null}

          <DeployWizard
            awsAccountId={awsAccountId}
            defaultStartUrl={awsSignIn?.startUrl ?? null}
            onAttach={onAttachAws}
            onChanged={load}
            onFinalized={finalized}
            projectId={projectId}
            repoBranch={project?.repoBranch ?? null}
            repoFullName={project?.repoFullName ?? null}
            state={state}
          />
        </>
      ) : null}

      {!showWizard && state ? (
        <>
          {/* Side by side, and the runnable half first: once the setup is done,
              the reason to open this tab is to start a run, while the configuration
              is what you check now and then. 5:3 of eight columns — the run card
              and the recent runs below it on the left, the config card a list of
              values on the right.

              One column below `lg`, where two of these would each be too narrow
              for an ARN. They stack in this same order, which is the same
              priority read downwards. */}
          <div className="grid items-start gap-4 lg:grid-cols-8">
            <div className="space-y-4 lg:col-span-5">
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Run Workflows</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {/* One button per workflow the setup turned on, so a workflow
                      added to the catalogue shows up here without touching this
                      card. Ones that change infrastructure ask for a second
                      click naming the account. */}
                  <div className="flex flex-wrap items-center gap-2">
                    {runWorkflows.map((workflow) => {
                      const id = workflow.id as DeployRunKind;
                      const disabled =
                        !ready ||
                        running !== null ||
                        blockerOf(workflow) !== null;
                      const icon =
                        running === id ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : workflow.changesInfrastructure ? (
                          <Rocket className="mr-2 h-4 w-4" />
                        ) : (
                          <PlayCircle className="mr-2 h-4 w-4" />
                        );

                      if (workflow.changesInfrastructure && confirming === id) {
                        return (
                          <span
                            className="flex items-center gap-2"
                            key={workflow.id}
                          >
                            <Button
                              disabled={disabled}
                              onClick={() => void startRun(workflow)}
                              variant="destructive"
                            >
                              {running === id ? (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                              ) : (
                                <ShieldAlert className="mr-2 h-4 w-4" />
                              )}
                              {workflow.name} in{" "}
                              {state.settings.awsAccountId ?? "AWS"}
                            </Button>
                            <Button
                              onClick={() => setConfirming(null)}
                              variant="ghost"
                            >
                              Cancel
                            </Button>
                          </span>
                        );
                      }

                      return (
                        <Button
                          disabled={disabled}
                          key={workflow.id}
                          onClick={() =>
                            workflow.changesInfrastructure
                              ? setConfirming(id)
                              : void startRun(workflow)
                          }
                          variant={
                            workflow.changesInfrastructure
                              ? "default"
                              : "outline"
                          }
                        >
                          {icon}
                          {workflow.name}
                        </Button>
                      );
                    })}

                    <Button
                      aria-label="Refresh runs"
                      onClick={() => void refreshRuns()}
                      size="icon"
                      variant="ghost"
                    >
                      <RefreshCw
                        className={`h-4 w-4 ${runInFlight ? "animate-spin" : ""}`}
                      />
                    </Button>

                    {destroyWorkflows.map((workflow) => (
                      <Button
                        className="ml-auto border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                        disabled={
                          !ready ||
                          running !== null ||
                          blockerOf(workflow) !== null
                        }
                        key={workflow.id}
                        onClick={() => {
                          setConfirming(null);
                          setDestroying(workflow);
                        }}
                        variant="outline"
                      >
                        {running === workflow.id ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <Flame className="mr-2 h-4 w-4" />
                        )}
                        {workflow.name}
                      </Button>
                    ))}
                  </div>

                  {/* What is running, and which buttons it holds back. Several
                      lines when workflows without a shared lock run at once. */}
                  {activeRuns(runs, workflows).map(({ run, workflow }) => {
                    const held = workflows
                      .filter(
                        (other) =>
                          other.id !== workflow.id &&
                          workflow.lock !== null &&
                          other.lock === workflow.lock,
                      )
                      .map((other) => other.name);
                    return (
                      <p
                        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs"
                        key={run.id}
                      >
                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                        <span>
                          <span className="font-medium text-foreground">
                            {run.name}
                          </span>{" "}
                          is {run.status === "queued" ? "queued" : "running"}{" "}
                          since{" "}
                          {new Date(run.createdAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                          .
                          {held.length > 0
                            ? ` ${held.join(" and ")} ${held.length === 1 ? "unlocks" : "unlock"} when it finishes.`
                            : ""}
                        </span>
                        <a
                          className="inline-flex items-center gap-1 underline-offset-2 hover:text-foreground hover:underline"
                          href={run.htmlUrl}
                          rel="noreferrer"
                          target="_blank"
                        >
                          View in GitHub
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      </p>
                    );
                  })}
                  {waiting.map((dispatch) => (
                    <p
                      className="flex items-center gap-2 text-muted-foreground text-xs"
                      key={`${dispatch.name}-${dispatch.at}`}
                    >
                      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                      Starting {dispatch.name}…
                    </p>
                  ))}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Recent runs</CardTitle>
                </CardHeader>
                <CardContent>
                  {state.runsError ? (
                    <p className="text-muted-foreground text-sm">
                      {state.runsError}
                    </p>
                  ) : state.runs.length === 0 ? (
                    <p className="text-muted-foreground text-sm">
                      No workflow has run yet.
                    </p>
                  ) : (
                    <ul className="space-y-1.5">
                      {state.runs.map((run) => (
                        <RunRow key={run.id} run={run} />
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </div>

            <Card className="lg:col-span-3">
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
                <CardTitle className="text-base">Config</CardTitle>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      aria-label="Config actions"
                      className="-mr-2 h-8 w-8"
                      size="icon"
                      variant="ghost"
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setReconfiguring(true)}>
                      <Pencil className="mr-2 h-3.5 w-3.5" />
                      Edit
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* One column: in a third of the row an 11rem label column left
                  no room for the ARNs beside it. */}
                <dl className="grid gap-y-2 text-sm">
                  <ConfigRow label="AWS account">
                    {state.settings.awsAccountId ?? "—"}
                  </ConfigRow>
                  <ConfigRow label="Region">
                    {state.settings.awsRegion}
                  </ConfigRow>
                  <ConfigRow
                    href={iamRoleConsoleUrl(state.settings.awsRoleArn)}
                    label="Deployment role"
                    linkLabel="Open the role in the IAM console"
                  >
                    {state.settings.awsRoleArn ?? "—"}
                  </ConfigRow>
                  <ConfigRow
                    href={s3BucketConsoleUrl(
                      state.settings.stateBucket,
                      state.settings.awsRegion,
                    )}
                    label="State bucket"
                    linkLabel="Open the bucket in the S3 console"
                  >
                    {state.settings.stateBucket ?? "—"}
                  </ConfigRow>

                  <ConfigRow
                    href={kmsKeyConsoleUrl(state.settings.stateKmsKeyArn)}
                    label="State encryption"
                    linkLabel="Open the key in the KMS console"
                  >
                    {state.settings.stateKmsKeyArn ?? "not encrypted with KMS"}
                  </ConfigRow>
                </dl>
              </CardContent>
            </Card>
          </div>
        </>
      ) : null}

      {state && project ? (
        <DestroyRunDialog
          awsAccountId={state.settings.awsAccountId}
          awsRegion={state.settings.awsRegion}
          onConfirm={(confirm) => {
            if (destroying) void startRun(destroying, confirm);
          }}
          onOpenChange={(open) => {
            // Not while the dispatch is in flight: closing then would hide
            // whether it was accepted.
            if (!open && running === null) setDestroying(null);
          }}
          open={destroying !== null}
          projectName={project.name}
          repo={`${project.repoFullName}@${project.repoBranch}`}
          starting={destroying !== null && running === destroying.id}
        />
      ) : null}
    </div>
  );
}

/**
 * One configured value, or a dash where there is nothing to show.
 *
 * With `href`, the value itself is the link, opening in a new tab. The value
 * rather than a separate icon button, because the value is what the eye is on
 * and the whole of it is a bigger target; the icon after it only says that it
 * leaves the app.
 */
function ConfigRow({
  children,
  href,
  label,
  linkLabel,
}: {
  children: React.ReactNode;
  href?: string | null;
  label: string;
  /** What the link opens, for the tooltip and for screen readers. */
  linkLabel?: string;
}) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mb-1 break-all font-mono text-xs sm:mb-0">
        {href ? (
          <a
            aria-label={
              linkLabel ? `${linkLabel} (opens in a new tab)` : undefined
            }
            className="group inline rounded-sm underline decoration-muted-foreground/40 decoration-dotted underline-offset-2 hover:text-primary hover:decoration-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            href={href}
            rel="noopener noreferrer"
            target="_blank"
            title={linkLabel}
          >
            {children}
            <ExternalLink
              aria-hidden
              className="ml-1 inline h-3 w-3 align-[-1px] text-muted-foreground group-hover:text-primary"
            />
          </a>
        ) : (
          children
        )}
      </dd>
    </>
  );
}

function RunRow({ run }: { run: WorkflowRunDto }) {
  const icon =
    run.status !== "completed" ? (
      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
    ) : run.conclusion === "success" ? (
      <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
    ) : run.conclusion === "failure" ? (
      <XCircle className="h-4 w-4 shrink-0 text-destructive" />
    ) : (
      <Circle className="h-4 w-4 shrink-0 text-muted-foreground" />
    );

  return (
    <li className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
      {icon}
      <span className="truncate">{run.name}</span>
      <span className="shrink-0 text-muted-foreground text-xs">
        {run.event}
      </span>
      <span className="ml-auto shrink-0 text-muted-foreground text-xs">
        {new Date(run.createdAt).toLocaleString()}
      </span>
      <a
        className="shrink-0 text-muted-foreground hover:text-foreground"
        href={run.htmlUrl}
        rel="noreferrer"
        target="_blank"
      >
        <ExternalLink className="h-3.5 w-3.5" />
      </a>
    </li>
  );
}
