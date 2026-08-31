"use client";

import { Button } from "@terrablox/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@terrablox/ui/card";
import { Skeleton } from "@terrablox/ui/skeleton";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Circle,
  ExternalLink,
  FileCode2,
  Loader2,
  PlayCircle,
  RefreshCw,
  Rocket,
  Settings2,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type {
  DeployRunKind,
  ProjectDeployState,
  ProjectDto,
  WorkflowRunDto,
} from "@/lib/projects/types";
import { DeployWizard, WIZARD_COLUMN } from "./deploy-wizard";

interface DeployPanelProps {
  projectId: string;
  project: ProjectDto | null;
  /** Passed through to the wizard's first step, which signs in to AWS. */
  onAttachAws: (accountId: string) => Promise<void>;
  /** The connected account, or null. Null reopens the wizard at step one. */
  awsAccountId: string | null;
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
 * proprietary runner — a project stays deployable without TerraBlox.
 */
export function DeployPanel({
  projectId,
  project,
  onAttachAws,
  awsAccountId,
}: DeployPanelProps) {
  const [state, setState] = useState<ProjectDeployState | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState<DeployRunKind | null>(null);
  const [confirmApply, setConfirmApply] = useState(false);
  const [reconfiguring, setReconfiguring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);

    try {
      const response = await fetch(`/api/projects/${projectId}/deploy`);
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error ?? "Failed to load");

      const deploy = body.deploy as ProjectDeployState;
      setState(deploy);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

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

  const runInFlight =
    state?.runs.some((run) => run.status !== "completed") ?? false;

  // A Terraform run takes minutes, and a status that only updates on reload
  // would send people to the Actions tab anyway.
  useEffect(() => {
    if (!runInFlight) return;

    const timer = setInterval(() => void refreshRuns(), 6000);
    return () => clearInterval(timer);
  }, [runInFlight, refreshRuns]);

  async function startRun(workflow: DeployRunKind) {
    if (running) return;

    setRunning(workflow);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch(`/api/projects/${projectId}/deploy/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow }),
      });

      const body = await response.json();
      if (!response.ok)
        throw new Error(body?.error ?? "Failed to start the run");

      setNotice(
        workflow === "apply"
          ? "Apply queued. If the production environment requires an approval, GitHub waits for it before touching AWS."
          : "Run queued.",
      );

      // GitHub registers the run a moment after accepting the dispatch.
      setTimeout(() => void refreshRuns(), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start the run");
    } finally {
      setRunning(null);
      setConfirmApply(false);
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
  // A disconnected account reopens the wizard whatever the setup says: the role
  // and the bucket may still exist, but nothing here can be created or re-read
  // until the project points at an account again.
  const showWizard =
    state !== null && (!configured || reconfiguring || awsAccountId === null);

  return (
    <div className={WIZARD_COLUMN}>
      {error ? (
        <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="flex items-start gap-2 rounded-lg border bg-muted/50 px-3 py-2 text-sm">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
          {notice}
        </p>
      ) : null}

      {showWizard && state ? (
        <>
          {configured && awsAccountId ? (
            <Button
              onClick={() => setReconfiguring(false)}
              size="sm"
              variant="ghost"
            >
              <ArrowLeft className="mr-2 h-3.5 w-3.5" />
              Back to the configuration
            </Button>
          ) : null}

          <DeployWizard
            awsAccountId={awsAccountId}
            onAttach={onAttachAws}
            onChanged={load}
            projectId={projectId}
            state={state}
          />
        </>
      ) : null}

      {!showWizard && state ? (
        <>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                Deployment is configured
              </CardTitle>
              <CardDescription>
                Terraform runs in GitHub Actions, which federates into your AWS
                account for the length of a job. No credentials are stored, and
                nothing is triggered by a push — a deployment only happens when
                you start one here.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[11rem_1fr]">
                <ConfigRow label="Repository">
                  {project
                    ? `${project.repoFullName}@${project.repoBranch}`
                    : "—"}
                </ConfigRow>
                <ConfigRow label="AWS account">
                  {state.settings.awsAccountId ?? "—"}
                </ConfigRow>
                <ConfigRow label="Region">{state.settings.awsRegion}</ConfigRow>
                <ConfigRow label="Deployment role">
                  {state.settings.awsRoleArn ?? "—"}
                </ConfigRow>
                <ConfigRow label="State bucket">
                  {state.settings.stateBucket ?? "—"}
                </ConfigRow>
                <ConfigRow label="Lock table">
                  {state.settings.stateLockTable ?? "none"}
                </ConfigRow>
                <ConfigRow label="State encryption">
                  {state.settings.stateKmsKeyArn ?? "not encrypted with KMS"}
                </ConfigRow>
                <ConfigRow label="Terraform">
                  {state.templates.config.terraformVersion}
                </ConfigRow>
              </dl>

              <ul className="space-y-1.5">
                {state.workflows.map((workflow) => (
                  <li
                    className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
                    key={workflow.path}
                  >
                    <FileCode2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="truncate font-mono text-xs">
                      {workflow.path}
                    </span>
                    {workflow.managed ? (
                      <span
                        className={`ml-auto shrink-0 rounded-full border px-2 py-0.5 font-medium text-[0.65rem] ${
                          workflow.upToDate
                            ? "text-emerald-600"
                            : "text-amber-600"
                        }`}
                      >
                        {workflow.upToDate ? "up to date" : "needs update"}
                      </span>
                    ) : (
                      <span className="ml-auto shrink-0 text-[0.65rem] text-muted-foreground">
                        your own
                      </span>
                    )}
                  </li>
                ))}
              </ul>

              <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
                <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                <span className="text-muted-foreground">
                  The deployment role has AdministratorAccess, so anyone who can
                  push to this repository or start a workflow in it can change
                  anything in account{" "}
                  {state.settings.awsAccountId ?? "this account"}.
                </span>
              </div>

              <Button
                onClick={() => setReconfiguring(true)}
                size="sm"
                variant="outline"
              >
                <Settings2 className="mr-2 h-3.5 w-3.5" />
                Change the setup
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Run Terraform</CardTitle>
              <CardDescription>
                Starts the workflow in GitHub Actions on{" "}
                <code className="rounded bg-muted px-1">
                  {project?.repoBranch ?? "main"}
                </code>
                . The credentials never leave the runner, and every run leaves a
                log you can audit.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  disabled={!ready || running !== null}
                  onClick={() => void startRun("plan")}
                  variant="outline"
                >
                  {running === "plan" ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <PlayCircle className="mr-2 h-4 w-4" />
                  )}
                  Plan
                </Button>

                {confirmApply ? (
                  <>
                    <Button
                      disabled={running !== null}
                      onClick={() => void startRun("apply")}
                      variant="destructive"
                    >
                      {running === "apply" ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <ShieldAlert className="mr-2 h-4 w-4" />
                      )}
                      Apply to {state.settings.awsAccountId ?? "AWS"}
                    </Button>
                    <Button
                      onClick={() => setConfirmApply(false)}
                      variant="ghost"
                    >
                      Cancel
                    </Button>
                  </>
                ) : (
                  <Button
                    disabled={!ready || running !== null}
                    onClick={() => setConfirmApply(true)}
                  >
                    <Rocket className="mr-2 h-4 w-4" />
                    Apply
                  </Button>
                )}

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
              </div>

              <p className="text-muted-foreground text-xs">
                Apply runs in the{" "}
                <code className="rounded bg-muted px-1">production</code>{" "}
                environment, so GitHub can hold it for an approval before
                anything changes in AWS.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Recent runs</CardTitle>
              <CardDescription>
                The last GitHub Actions runs for this repository.
              </CardDescription>
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
        </>
      ) : null}
    </div>
  );
}

/** One configured value, or a dash where there is nothing to show. */
function ConfigRow({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mb-1 break-all font-mono text-xs sm:mb-0">{children}</dd>
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
