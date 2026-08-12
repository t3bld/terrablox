"use client";

import { Button } from "@terrablox/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@terrablox/ui/card";
import { Input } from "@terrablox/ui/input";
import { Label } from "@terrablox/ui/label";
import { Skeleton } from "@terrablox/ui/skeleton";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Copy,
  Download,
  ExternalLink,
  FileCode2,
  Loader2,
  PlayCircle,
  RefreshCw,
  Rocket,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type {
  DeployRunKind,
  ProjectDeploySettings,
  ProjectDeployState,
  ProjectDto,
  WorkflowRunDto,
} from "@/lib/projects/types";

interface DeployPanelProps {
  projectId: string;
  project: ProjectDto | null;
}

type SettingsForm = {
  awsAccountId: string;
  awsRegion: string;
  awsRoleArn: string;
  stateBucket: string;
  stateLockTable: string;
};

function toForm(settings: ProjectDeploySettings): SettingsForm {
  return {
    awsAccountId: settings.awsAccountId ?? "",
    awsRegion: settings.awsRegion,
    awsRoleArn: settings.awsRoleArn ?? "",
    stateBucket: settings.stateBucket ?? "",
    stateLockTable: settings.stateLockTable ?? "",
  };
}

/**
 * Everything needed to get the project's Terraform running in CI.
 *
 * The pipeline itself lives in the repository as ordinary workflow files, so
 * this panel generates and inspects them rather than hiding them behind a
 * proprietary runner — a project stays deployable without TerraBlox.
 */
export function DeployPanel({ projectId, project }: DeployPanelProps) {
  const [state, setState] = useState<ProjectDeployState | null>(null);
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [running, setRunning] = useState<DeployRunKind | null>(null);
  const [confirmApply, setConfirmApply] = useState(false);
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
      setForm((current) => current ?? toForm(deploy.settings));
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

  async function saveSettings() {
    if (!form || saving) return;

    setSaving(true);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch(`/api/projects/${projectId}/deploy`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      const body = await response.json();
      if (!response.ok) throw new Error(body?.error ?? "Failed to save");

      setState(body.deploy as ProjectDeployState);
      setNotice("Settings saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function generatePipeline() {
    if (generating) return;

    setGenerating(true);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch(
        `/api/projects/${projectId}/deploy/pipeline`,
        { method: "POST" },
      );

      const body = await response.json();
      if (!response.ok) throw new Error(body?.error ?? "Failed to generate");

      setState(body.deploy as ProjectDeployState);
      setNotice(
        body.commit
          ? `Committed ${body.commit.paths.length} file(s) as ${String(
              body.commit.sha,
            ).slice(0, 7)}.`
          : "The pipeline was already up to date.",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate");
    } finally {
      setGenerating(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-4xl space-y-4 p-6">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  const ready = state !== null && state.missing.length === 0;

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
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

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            {ready ? "Ready to deploy" : "Not deployable yet"}
          </CardTitle>
          <CardDescription>
            {ready
              ? "Pushing to the deployment branch runs terraform apply through GitHub Actions."
              : `Still missing: ${state?.missing.join(", ")}.`}
          </CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">AWS account</CardTitle>
          <CardDescription>
            The pipeline assumes an IAM role through GitHub&rsquo;s OIDC
            provider. No access keys are created, stored or committed.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {form ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  id="aws-account"
                  label="Account ID"
                  placeholder="123456789012"
                  value={form.awsAccountId}
                  onChange={(value) =>
                    setForm({ ...form, awsAccountId: value })
                  }
                />
                <Field
                  id="aws-region"
                  label="Region"
                  placeholder="eu-central-1"
                  value={form.awsRegion}
                  onChange={(value) => setForm({ ...form, awsRegion: value })}
                />
              </div>
              <Field
                id="aws-role"
                label="Deployment role ARN"
                placeholder="arn:aws:iam::123456789012:role/terrablox-deploy"
                value={form.awsRoleArn}
                onChange={(value) => setForm({ ...form, awsRoleArn: value })}
              />

              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  id="state-bucket"
                  label="State bucket (S3)"
                  placeholder="my-terraform-state"
                  value={form.stateBucket}
                  onChange={(value) => setForm({ ...form, stateBucket: value })}
                />
                <Field
                  id="state-lock"
                  label="Lock table (DynamoDB)"
                  placeholder="Optional"
                  value={form.stateLockTable}
                  onChange={(value) =>
                    setForm({ ...form, stateLockTable: value })
                  }
                />
              </div>

              <div className="flex items-center gap-2">
                <Button onClick={() => void saveSettings()} disabled={saving}>
                  {saving ? "Saving…" : "Save settings"}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => void load()}
                  aria-label="Reload"
                >
                  <RefreshCw className="h-4 w-4" />
                </Button>
              </div>
            </>
          ) : null}

          {state ? (
            <Collapsible label="Set up the AWS side">
              <p className="text-sm text-muted-foreground">
                One CloudFormation stack creates everything the pipeline needs:
                the GitHub identity provider, the deployment role limited to
                this repository, the versioned state bucket
                {state.settings.stateLockTable ? " and the lock table" : ""}.
                Run it with your own AWS credentials — TerraBlox has none, which
                is why it cannot do this for you.
              </p>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    downloadFile(
                      "terrablox-bootstrap.yml",
                      state.bootstrap.template,
                    )
                  }
                >
                  <Download className="mr-2 h-3.5 w-3.5" />
                  Download template
                </Button>
                <a
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  href={state.bootstrap.consoleUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Or upload it in the CloudFormation console
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>

              <CodeBlock
                content={state.bootstrap.command}
                label="bootstrap command"
                language="bash"
              />

              <p className="text-sm text-muted-foreground">
                The stack&rsquo;s outputs are the values for the fields above.
                The role starts with read-only permissions, so a plan works
                immediately and an apply fails until you widen{" "}
                <code className="rounded bg-muted px-1">
                  PermissionsPolicyArn
                </code>{" "}
                to what this project really deploys.
              </p>

              <Collapsible label={`${state.bootstrap.stackName}.yml`}>
                <CodeBlock
                  content={state.bootstrap.template}
                  label="bootstrap template"
                  language="yaml"
                />
              </Collapsible>

              <Collapsible label="Trust policy only">
                <CodeBlock
                  content={state.trustPolicy}
                  label="Trust policy"
                  language="json"
                />
              </Collapsible>

              <a
                className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                href="https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_create_for-idp_oidc.html"
                target="_blank"
                rel="noreferrer"
              >
                AWS documentation on OIDC roles
                <ExternalLink className="h-3 w-3" />
              </a>
            </Collapsible>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Pipeline</CardTitle>
          <CardDescription>
            A plan on every pull request, an apply on{" "}
            <code className="rounded bg-muted px-1">
              {project?.repoBranch ?? "main"}
            </code>
            . The apply job runs in the{" "}
            <code className="rounded bg-muted px-1">production</code>{" "}
            environment, so you can require an approval for it in GitHub.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="space-y-1.5">
            {state?.workflows.map((workflow) => (
              <li
                key={workflow.path}
                className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
              >
                <FileCode2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate font-mono text-xs">
                  {workflow.path}
                </span>
                {workflow.managed ? (
                  <span
                    className={`ml-auto shrink-0 rounded-full border px-2 py-0.5 text-[0.65rem] font-medium ${
                      workflow.upToDate ? "text-emerald-600" : "text-amber-600"
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
            {state?.hasBackendFile === false && state.settings.stateBucket ? (
              <li className="flex items-center gap-2 rounded-md border border-amber-500/40 px-3 py-2 text-sm">
                <AlertCircle className="h-4 w-4 shrink-0 text-amber-600" />
                No backend file in the repository — state would be local to each
                run.
              </li>
            ) : null}
          </ul>

          <div className="flex items-center gap-2">
            <Button
              onClick={() => void generatePipeline()}
              disabled={generating || !state?.settings.awsRoleArn}
            >
              {generating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Committing…
                </>
              ) : (
                "Generate pipeline"
              )}
            </Button>
            {!state?.settings.awsRoleArn ? (
              <span className="text-xs text-muted-foreground">
                Set the role ARN first.
              </span>
            ) : null}
          </div>

          {state?.preview.map((file) => (
            <Collapsible key={file.path} label={file.path}>
              <CodeBlock content={file.content} label={file.path} />
            </Collapsible>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Run Terraform</CardTitle>
          <CardDescription>
            Starts the workflow in GitHub Actions, which federates into your AWS
            account for the length of the job. The credentials never leave the
            runner, and every run leaves a log you can audit.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              onClick={() => void startRun("plan")}
              disabled={!ready || running !== null}
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
                  variant="destructive"
                  onClick={() => void startRun("apply")}
                  disabled={running !== null}
                >
                  {running === "apply" ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <ShieldAlert className="mr-2 h-4 w-4" />
                  )}
                  Apply to {state?.settings.awsAccountId ?? "AWS"}
                </Button>
                <Button variant="ghost" onClick={() => setConfirmApply(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                onClick={() => setConfirmApply(true)}
                disabled={!ready || running !== null}
              >
                <Rocket className="mr-2 h-4 w-4" />
                Apply
              </Button>
            )}

            <Button
              variant="ghost"
              size="icon"
              onClick={() => void refreshRuns()}
              aria-label="Refresh runs"
            >
              <RefreshCw
                className={`h-4 w-4 ${runInFlight ? "animate-spin" : ""}`}
              />
            </Button>
          </div>

          <p className="text-xs text-muted-foreground">
            {ready
              ? "Apply runs in the production environment, so GitHub can hold it for an approval before anything changes in AWS."
              : "Fill in the AWS settings and generate the pipeline before running anything."}
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
          {state?.runsError ? (
            <p className="text-sm text-muted-foreground">{state.runsError}</p>
          ) : state?.runs.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No workflow has run yet.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {state?.runs.map((run) => (
                <RunRow key={run.id} run={run} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** The template has to reach the user's own AWS CLI or console, not our server. */
function downloadFile(name: string, content: string) {
  const url = URL.createObjectURL(
    new Blob([content], { type: "text/yaml;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function Field({
  id,
  label,
  value,
  placeholder,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="font-mono text-sm"
      />
    </div>
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
    <li>
      <a
        href={run.htmlUrl}
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted/60"
      >
        {icon}
        <span className="truncate">{run.name}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {run.headBranch} · {run.event}
        </span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {new Date(run.createdAt).toLocaleString()}
        </span>
        <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
      </a>
    </li>
  );
}

function Collapsible({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-lg border">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium"
      >
        {open ? (
          <ChevronDown className="h-4 w-4" />
        ) : (
          <ChevronRight className="h-4 w-4" />
        )}
        <span className="truncate font-mono text-xs">{label}</span>
      </button>
      {open ? <div className="space-y-2 border-t p-3">{children}</div> : null}
    </div>
  );
}

function CodeBlock({
  content,
  label,
  language,
}: {
  content: string;
  label: string;
  language?: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Copy ${label}`}
        className="absolute right-1 top-1 h-7 w-7"
        onClick={() => {
          void navigator.clipboard.writeText(content).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-emerald-600" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </Button>
      <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs">
        <code data-language={language}>{content}</code>
      </pre>
    </div>
  );
}
