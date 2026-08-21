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
import { ToggleRow } from "@terrablox/ui/toggle-row";
import {
  AlertCircle,
  Check,
  ExternalLink,
  FileCode2,
  KeyRound,
  Loader2,
  Lock,
  Plug,
  Rocket,
  ShieldAlert,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { DEPLOY_PERMISSIONS_POLICY_ARN } from "@/lib/projects/deploy";
import type { ProjectDeployState, ProjectDto } from "@/lib/projects/types";

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
  project: ProjectDto | null;
  state: ProjectDeployState;
  /** Re-reads the deploy state, because every step changes what the next sees. */
  onChanged: () => void | Promise<void>;
}

type StepId = "account" | "role" | "variables" | "state" | "pipeline";

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
  project,
  state,
  onChanged,
}: DeployWizardProps) {
  const [roleStack, setRoleStack] = useState<StackDto | null>(null);
  const [stateStack, setStateStack] = useState<StackDto | null>(null);
  const [connection, setConnection] = useState<{
    connected: boolean;
    message: string | null;
  } | null>(null);
  const [busy, setBusy] = useState<StepId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [region, setRegion] = useState(state.settings.awsRegion);
  const [reuseOidc, setReuseOidc] = useState(false);

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
      setRoleStack((body.role as StackDto | null) ?? null);
      setStateStack((body.state as StackDto | null) ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to read");
    }
  }, [projectId]);

  useEffect(() => {
    void readStacks();
  }, [readStacks]);

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

  const done: Record<StepId, boolean> = {
    account: connection?.connected ?? false,
    role: state.setup.roleReady,
    variables: state.setup.variablesReady,
    state: state.setup.stateReady,
    pipeline: state.setup.pipelineReady,
  };

  const order: StepId[] = ["account", "role", "variables", "state", "pipeline"];
  const current = order.find((id) => !done[id]) ?? null;

  async function post(step: StepId, url: string, payload?: unknown) {
    setBusy(step);
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

  async function patch(step: StepId, payload: unknown, message: string) {
    setBusy(step);
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

  async function applyStack(stack: "role" | "state", step: StepId) {
    const body = await post(
      step,
      `/api/projects/${projectId}/deploy/bootstrap`,
      {
        action: "apply",
        stack,
        ...(stack === "role" ? { createOidcProvider: !reuseOidc } : {}),
      },
    );
    if (!body) return;

    const next = (body.stack as StackDto | null) ?? null;
    if (stack === "role") setRoleStack(next);
    else setStateStack(next);

    setNotice(
      body.started
        ? "CloudFormation is building the stack."
        : "The stack was already up to date.",
    );
    await onChanged();
  }

  async function adoptStack(stack: "role" | "state", step: StepId) {
    const body = await post(
      step,
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
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Set up deployment</CardTitle>
          <CardDescription>
            Five steps to the point where you can deploy{" "}
            <code className="rounded bg-muted px-1">
              {project?.repoFullName ?? "this repository"}
            </code>{" "}
            into your AWS account from this tab. Nothing runs on a push — every
            deployment stays something you start by hand.
          </CardDescription>
        </CardHeader>
      </Card>

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

      <ol className="space-y-3">
        <Step
          active={current === "account"}
          description="TerraBlox needs a verified connection to create the role and the state backend for you. It is only used for this setup — the deployment itself federates from GitHub."
          done={done.account}
          icon={Plug}
          index={1}
          title="Connect the AWS account"
        >
          {connection && !connection.connected ? (
            <div className="space-y-3">
              <p className="text-muted-foreground text-sm">
                {connection.message ?? "No AWS account is connected yet."}
              </p>
              <Button asChild size="sm" variant="outline">
                <Link href="/account">
                  Connect an account
                  <ExternalLink className="ml-2 h-3.5 w-3.5" />
                </Link>
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid max-w-xs gap-2">
                <Label htmlFor="wizard-region">Region</Label>
                <Input
                  className="font-mono text-sm"
                  id="wizard-region"
                  onChange={(event) => setRegion(event.target.value)}
                  placeholder="eu-central-1"
                  value={region}
                />
              </div>
              <p className="text-muted-foreground text-xs">
                Where the state bucket and everything this project deploys will
                live. Changing it later means moving the state by hand.
              </p>
              {region.trim() !== state.settings.awsRegion ? (
                <Button
                  disabled={busy !== null}
                  onClick={() =>
                    void patch(
                      "account",
                      { awsRegion: region.trim() },
                      "Region saved.",
                    )
                  }
                  size="sm"
                  variant="outline"
                >
                  {busy === "account" ? (
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  ) : null}
                  Save region
                </Button>
              ) : null}
            </div>
          )}
        </Step>

        <Step
          active={current === "role"}
          description="One CloudFormation stack: the GitHub identity provider, and an IAM role that only this repository on this branch may assume."
          done={done.role}
          icon={KeyRound}
          index={2}
          title="Create the deployment role"
        >
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div className="space-y-1 text-xs">
                <p className="font-medium">
                  The role gets AdministratorAccess.
                </p>
                <p className="text-muted-foreground">
                  Terraform can be asked to create anything, and a narrower role
                  fails part-way through an apply instead of at the plan. The
                  consequence is that anyone who can push to{" "}
                  <code className="rounded bg-muted px-1">
                    {project?.repoFullName ?? "this repository"}
                  </code>
                  , or start a workflow in it, can do anything in this AWS
                  account. It is a stack parameter, so you can narrow it later
                  without regenerating anything.
                </p>
                <p className="font-mono text-muted-foreground">
                  {DEPLOY_PERMISSIONS_POLICY_ARN}
                </p>
              </div>
            </div>

            <StackControls
              busy={busy === "role"}
              disabled={busy !== null || building}
              onRun={() => void applyStack("role", "role")}
              stack={roleStack}
            />

            {/* An account can hold only one provider per URL, so the second
                project to be set up has to reuse the first one's. */}
            {roleStack?.settled && !roleStack.succeeded ? (
              <label className="flex items-start gap-2 text-muted-foreground text-xs">
                <input
                  checked={reuseOidc}
                  className="mt-0.5"
                  onChange={(event) => setReuseOidc(event.target.checked)}
                  type="checkbox"
                />
                This account already trusts GitHub — reuse the existing identity
                provider instead of creating it.
              </label>
            ) : null}
          </div>
        </Step>

        <Step
          active={current === "variables"}
          description="Takes the role ARN and the account id from the stack and writes them to the repository's Actions variables, which is what the workflow reads at run time."
          done={done.variables}
          icon={Check}
          index={3}
          title="Save the role for the pipeline"
        >
          <div className="space-y-3">
            <VariableRow
              expected={state.settings.awsRoleArn}
              label="TERRABLOX_AWS_ROLE_ARN"
              value={state.variables.role}
            />
            <VariableRow
              expected={state.settings.awsRegion}
              label="TERRABLOX_AWS_REGION"
              value={state.variables.region}
            />
            <VariableRow
              expected={state.settings.stateBucket}
              label="TERRABLOX_STATE_BUCKET"
              value={state.variables.stateBucket}
            />

            {state.variables.error ? (
              <p className="text-muted-foreground text-xs">
                {state.variables.error}
              </p>
            ) : null}

            <Button
              disabled={busy !== null || !(roleStack?.succeeded ?? false)}
              onClick={() => void adoptStack("role", "variables")}
              size="sm"
            >
              {busy === "variables" ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : null}
              Save the role
            </Button>
            {roleStack?.succeeded ? null : (
              <p className="text-muted-foreground text-xs">
                Waiting for the role stack to finish.
              </p>
            )}
          </div>
        </Step>

        <Step
          active={current === "state"}
          description="A second stack for the Terraform state: a customer-managed KMS key, the versioned S3 bucket it encrypts, and the DynamoDB table that holds the lock."
          done={done.state}
          icon={Lock}
          index={4}
          title="Deploy the state backend"
        >
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
                {state.settings.stateLockTable ?? "named for you when it runs"}
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
              <code className="rounded bg-muted px-1">kms:Decrypt</code> on it,
              and TerraBlox asks for a session scoped to that one object and
              that one key.
            </p>

            <StackControls
              busy={busy === "state"}
              disabled={busy !== null || building || !done.role}
              onRun={() => void applyStack("state", "state")}
              stack={stateStack}
            />

            {done.role ? null : (
              <p className="text-muted-foreground text-xs">
                The role has to exist first — the key grants it access by name.
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
        </Step>

        <Step
          active={current === "pipeline"}
          description="Writes the workflow templates and the S3 backend into the repository. They only ever start on workflow_dispatch, so committing them changes nothing on its own."
          done={done.pipeline}
          icon={FileCode2}
          index={5}
          title="Configure and commit the workflows"
        >
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
        </Step>
      </ol>
    </div>
  );
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
          {stack ? "Run it again" : "Create it in AWS"}
        </Button>
        {stack ? (
          <span className="font-mono text-muted-foreground text-xs">
            {stack.status}
          </span>
        ) : null}
      </div>

      {stack?.statusReason && !stack.succeeded ? (
        <p className="text-muted-foreground text-xs">{stack.statusReason}</p>
      ) : null}
    </div>
  );
}

/**
 * One step, which is either the one to do now, already done, or still ahead.
 *
 * Only the active step shows its controls. A stepper that let every button be
 * pressed at any time would be the panel this replaced.
 */
function Step({
  active,
  children,
  description,
  done,
  icon: Icon,
  index,
  title,
}: {
  active: boolean;
  children: React.ReactNode;
  description: string;
  done: boolean;
  icon: typeof Plug;
  index: number;
  title: string;
}) {
  return (
    <li>
      <Card className={active ? "border-primary/60" : undefined}>
        <CardHeader className="pb-3">
          <div className="flex items-start gap-3">
            <span
              className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border font-medium text-xs ${
                done
                  ? "border-emerald-600/40 bg-emerald-600/10 text-emerald-700"
                  : active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "text-muted-foreground"
              }`}
            >
              {done ? <Check className="h-3.5 w-3.5" /> : index}
            </span>
            <div className="min-w-0 flex-1">
              <CardTitle className="flex items-center gap-2 text-base">
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                {title}
              </CardTitle>
              <CardDescription>{description}</CardDescription>
            </div>
          </div>
        </CardHeader>
        {active ? <CardContent>{children}</CardContent> : null}
      </Card>
    </li>
  );
}

/** A variable next to what it should be, so a stale one is visible as stale. */
function VariableRow({
  expected,
  label,
  value,
}: {
  expected: string | null;
  label: string;
  value: string | null;
}) {
  const matches = value !== null && value === expected;

  return (
    <div className="flex items-center gap-2 text-xs">
      {matches ? (
        <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
      ) : (
        <AlertCircle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="shrink-0 font-mono">{label}</span>
      <span className="truncate text-muted-foreground">
        {value ?? "not set"}
      </span>
    </div>
  );
}
