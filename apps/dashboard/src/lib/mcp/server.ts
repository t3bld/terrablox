import "server-only";

import { McpServer } from "@modelcontextprotocol/server";
import type { Project } from "@terrablox/database";
import { dispatchWorkflow } from "@terrablox/git/actions";
import { z } from "zod";

import type { Caller } from "@/lib/api/guard";
import { ApiError } from "@/lib/api/route-error";
import { audit } from "@/lib/audit/log";
import { githubTokenForUser } from "@/lib/auth/server-helpers";
import { database } from "@/lib/database";
import { loadModuleDetail } from "@/lib/module-library/detail-service";
import { importModuleFromGit } from "@/lib/module-library/import-from-git";
import { parseOutputs, parseVariables } from "@/lib/module-library/types";
import { readProjectLog, recordDecision } from "@/lib/projects/decisions";
import { missingDeploySettings } from "@/lib/projects/deploy";
import { readDeployState } from "@/lib/projects/deploy-service";
import { libraryModuleName } from "@/lib/projects/graph";
import { toProjectDto } from "@/lib/projects/serialize";
import {
  applyProjectMutation,
  findOwnedProject,
  loadProjectGraph,
  readModuleLibrary,
} from "@/lib/projects/service";
import type { ProjectGraphMutation } from "@/lib/projects/types";
import { findTemplate } from "@/lib/projects/workflow-templates";

/**
 * The dashboard's own operations, offered over MCP.
 *
 * The distinction from `apps/mcp-server` is worth stating, because they are two servers
 * with the same word in the name. That one is a stdio process serving a committed
 * snapshot of the public module catalogue: no credentials, no database, runs offline, and
 * can only answer questions. This one *is* the product — it authenticates as a user,
 * reads their projects and commits Terraform to their repositories.
 *
 * Which means the interesting property here is not what it can do, it is that everything
 * it does goes through the same service functions the web UI calls. `applyProjectMutation`
 * is the only path from anything to a Terraform file, so an edit made from an editor gets
 * the same validation, the same single-commit-per-edit behaviour and the same operation
 * row as one made by clicking. The tools are a second doorway, not a second
 * implementation.
 *
 * Every edit is recorded with `origin: "mcp"`, which is a deliberate admission: our own
 * agent runs inside the harness with its operating rules, budgets and interface checks,
 * and a foreign agent does not. Being able to tell the two apart afterwards matters more
 * than the tidiness of reusing `agent`.
 */

/** Read-only, in the sense the protocol means: it cannot change anything. */
const READ_ONLY = { readOnlyHint: true } as const;

/** Changes state. `destructiveHint` is set separately where it also removes things. */
const WRITES = { readOnlyHint: false } as const;

const PROJECT_ID = z
  .string()
  .describe("Project id, as returned by list_projects.");

/** JSON as a tool result, which is what a model parses most reliably. */
function json(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function refuse(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

/**
 * Builds the server for one authenticated caller.
 *
 * A factory per request rather than a singleton, because the caller is baked in: there is
 * no tool here that takes a user id, so there is no way for a request to reach another
 * person's data by passing one. The handler in the route is what establishes who this is.
 */
export function createDashboardMcpServer(caller: Caller): McpServer {
  const server = new McpServer({
    name: "terrablox",
    version: "0.1.0",
  });

  /**
   * The project and a GitHub token, or a refusal fit to hand back to a model.
   *
   * Both halves fail for reasons a caller can act on, and they are different actions:
   * a missing project usually means the wrong id, a missing token means the GitHub
   * account is not linked. Collapsing them into one message cost an afternoon once.
   */
  async function open(
    projectId: string,
  ): Promise<
    { ok: true; project: Project; token: string } | { ok: false; error: string }
  > {
    const project = await findOwnedProject(caller.userId, projectId);
    if (!project) {
      return {
        ok: false,
        error: `No project ${projectId}. Call list_projects for the ones you can reach.`,
      };
    }

    const token = await githubTokenForUser(caller.userId);
    if (!token) {
      return {
        ok: false,
        error:
          "No GitHub token for this account. Link GitHub in the dashboard, then try again.",
      };
    }

    return { ok: true, project, token };
  }

  /**
   * Applies one graph edit, which is the only way anything here writes Terraform.
   *
   * Every mutating tool below funnels through this. The alternative — a handler per
   * action — is how the canvas and the agent would have ended up with three different
   * ideas of what `connect` means, and the reason they have not is that both already go
   * through `applyProjectMutation`. This is the third caller, not a third implementation.
   */
  /**
   * A refusal when this caller may not change anything, or null.
   *
   * Checked per tool rather than at the endpoint, and the difference is not cosmetic:
   * the endpoint once required write access merely to *connect*, which made the
   * settings screen's default — a read-only token — unable to so much as list the
   * tools. A read-only caller should read everything and be told plainly at the one
   * call that would change something.
   */
  function readOnlyRefusal() {
    if (caller.canWrite) return null;

    return refuse(
      "This token is read-only, so it cannot change anything. Create a token with write access in the dashboard under Account → Editor access.",
    );
  }

  async function edit(projectId: string, mutation: ProjectGraphMutation) {
    const denied = readOnlyRefusal();
    if (denied) return denied;

    const opened = await open(projectId);
    if (!opened.ok) return refuse(opened.error);

    try {
      const result = await applyProjectMutation(
        opened.token,
        opened.project,
        mutation,
        { origin: "mcp" },
      );

      return json({
        committed: result.commit !== null,
        commit: result.commit?.sha ?? null,
        message: result.commit?.message ?? null,
        modules: result.graph.nodes
          .filter((node) => node.kind === "module")
          .map((node) => node.id),
      });
    } catch (error) {
      // The service throws sentences meant for a person — a name collision, an input
      // the module does not declare — so they are passed through rather than replaced
      // with a status code a model cannot act on.
      return refuse(
        error instanceof ApiError || error instanceof Error
          ? error.message
          : "The edit could not be applied.",
      );
    }
  }

  // ---- Reading ------------------------------------------------------------

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description:
        "Every project this account owns: id, name, the GitHub repository its Terraform lives in, and the branch. Start here — every other tool takes a project id.",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () => {
      const rows = await database.project.findMany({
        where: { userId: caller.userId },
        orderBy: { createdAt: "desc" },
      });

      return json({
        projects: rows.map((project) => {
          const dto = toProjectDto(project);
          return {
            id: dto.id,
            name: dto.name,
            description: dto.description,
            repo: dto.repoFullName,
            branch: dto.repoBranch,
          };
        }),
      });
    },
  );

  server.registerTool(
    "get_graph",
    {
      title: "Get the project graph",
      description:
        "The project's Terraform as a graph, read from the repository at the current head: every module block with the arguments it sets, every local, and the wires between them. This is the state every edit is computed against, so read it before changing anything.",
      inputSchema: z.object({ projectId: PROJECT_ID }),
      annotations: READ_ONLY,
    },
    async ({ projectId }) => {
      const opened = await open(projectId);
      if (!opened.ok) return refuse(opened.error);

      const graph = await loadProjectGraph(opened.token, opened.project);

      return json({
        sha: graph.sha,
        nodes: graph.nodes.map((node) => ({
          id: node.id,
          kind: node.kind,
          module: node.moduleName ?? null,
          version: node.version ?? null,
          arguments: node.values ?? {},
          expression: node.expression ?? null,
        })),
        edges: graph.edges,
      });
    },
  );

  server.registerTool(
    "list_modules",
    {
      title: "List the module library",
      description:
        "The modules this account can instantiate, with the id that add_module takes. These are the curated, version-pinned modules the project is assembled from — prefer them over writing resources by hand.",
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe("Filter by substring of the name or description."),
      }),
      annotations: READ_ONLY,
    },
    async ({ query }) => {
      const library = await readModuleLibrary(caller.userId);
      const needle = query?.trim().toLowerCase() ?? "";

      const matches = needle
        ? library.filter(
            (mod) =>
              libraryModuleName(mod).toLowerCase().includes(needle) ||
              (mod.description?.toLowerCase().includes(needle) ?? false),
          )
        : library;

      return json({
        total: library.length,
        modules: matches.map((mod) => ({
          id: mod.id,
          name: libraryModuleName(mod),
          description: mod.description ?? null,
          version: mod.versionTag,
        })),
      });
    },
  );

  server.registerTool(
    "describe_module",
    {
      title: "Describe a module",
      description:
        "One module in full: every input with its declared type, whether it is required and what it defaults to, plus every output. Call this before wiring a module rather than guessing a port name — a wrong name is committed as written and only fails at plan time.",
      inputSchema: z.object({
        moduleId: z.string().describe("Library module id, from list_modules."),
      }),
      annotations: READ_ONLY,
    },
    async ({ moduleId }) => {
      const detail = await loadModuleDetail(caller.userId, moduleId);
      if (!detail) return refuse(`No module ${moduleId} in your library.`);

      return json({
        id: detail.id,
        name: detail.effectiveName,
        description: detail.effectiveDescription,
        version: detail.versionTag,
        repo: detail.source?.url ?? null,
        inputs: parseVariables(detail.variables).map((input) => ({
          name: input.name,
          type: input.type,
          required: input.required ?? false,
          description: input.description,
          ...(Object.hasOwn(input, "default")
            ? { default: input.default }
            : {}),
        })),
        outputs: parseOutputs(detail.outputs).map((output) => ({
          name: output.name,
          description: output.description,
        })),
        resourceTypes: [
          ...new Set(detail.resources.map((res) => res.resourceType)),
        ].sort(),
      });
    },
  );

  server.registerTool(
    "get_project_log",
    {
      title: "Get the project log",
      description:
        "What has been decided and changed in this project: the recorded architecture decisions with their reasoning, and the operations that followed from them. Read this before proposing changes — it is where you find out why the project looks the way it does.",
      inputSchema: z.object({ projectId: PROJECT_ID }),
      annotations: READ_ONLY,
    },
    async ({ projectId }) => {
      const project = await findOwnedProject(caller.userId, projectId);
      if (!project) return refuse(`No project ${projectId}.`);

      return json(await readProjectLog(project.id));
    },
  );

  // ---- Editing the graph --------------------------------------------------
  //
  // Named per action rather than one `apply_edit` taking a discriminated union. The
  // union is what the service takes and what the HTTP route parses, and it is the right
  // shape there; as a *tool* it would hand a model one description covering thirteen
  // behaviours and a schema it has to get right by construction. The names deliberately
  // match the harness's own vocabulary in `@terrablox/agent-harness/tool-catalogue`, so
  // the two agents speak about this project in the same words.

  server.registerTool(
    "add_module",
    {
      title: "Add a module",
      description:
        "Instantiate a library module as a new `module` block and commit it. Returns the block label it received, which may carry a suffix if the preferred one was taken.",
      inputSchema: z.object({
        projectId: PROJECT_ID,
        moduleId: z.string().describe("Library module id, from list_modules."),
        name: z
          .string()
          .optional()
          .describe("Preferred block label. A suffix is added on collision."),
      }),
      annotations: WRITES,
    },
    ({ projectId, moduleId, name }) =>
      edit(projectId, {
        action: "add-module",
        moduleId,
        ...(name ? { name } : {}),
      }),
  );

  server.registerTool(
    "remove_module",
    {
      title: "Remove a module",
      description:
        "Delete a `module` block and every argument elsewhere that referenced it, so the configuration still plans. Destructive: this commits a deletion to the repository.",
      inputSchema: z.object({
        projectId: PROJECT_ID,
        name: z.string().describe("Block label to remove."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    ({ projectId, name }) => edit(projectId, { action: "remove-module", name }),
  );

  server.registerTool(
    "connect",
    {
      title: "Connect two modules",
      description:
        "Wire one module's output into another module's input: `target.targetInput = module.source.sourceOutput`. Both port names are checked against the modules' real interfaces, so a misremembered name is refused rather than committed.",
      inputSchema: z.object({
        projectId: PROJECT_ID,
        source: z.string(),
        sourceOutput: z.string(),
        target: z.string(),
        targetInput: z.string(),
      }),
      annotations: WRITES,
    },
    ({ projectId, source, sourceOutput, target, targetInput }) =>
      edit(projectId, {
        action: "connect",
        source,
        sourceOutput,
        target,
        targetInput,
      }),
  );

  server.registerTool(
    "disconnect",
    {
      title: "Disconnect an input",
      description:
        "Clear an input that is fed by another module's output. Use disconnect_local for an input fed by a variable.",
      inputSchema: z.object({
        projectId: PROJECT_ID,
        target: z.string(),
        targetInput: z.string(),
      }),
      annotations: WRITES,
    },
    ({ projectId, target, targetInput }) =>
      edit(projectId, { action: "disconnect", target, targetInput }),
  );

  server.registerTool(
    "auto_connect",
    {
      title: "Auto-connect a module",
      description:
        "Fill a module's unset inputs from the modules already in the project, wherever exactly one output fits by name. Never guesses: an input two modules could both supply, or one matching nothing, is left alone. One operation however many wires it draws, so this is the cheap way to attach a module you just added.",
      inputSchema: z.object({
        projectId: PROJECT_ID,
        name: z.string().describe("Module whose inputs should be filled."),
      }),
      annotations: WRITES,
    },
    ({ projectId, name }) => edit(projectId, { action: "auto-connect", name }),
  );

  server.registerTool(
    "set_module_arguments",
    {
      title: "Set module arguments",
      description:
        'Set one or more inputs of a module to raw HCL. A bare string is quoted for you; `var.env`, `["a", "b"]` or an interpolation are written through unchanged. To point an input at another module or a variable use connect or connect_local instead, which check that the target exists. All values land in a single commit.',
      inputSchema: z.object({
        projectId: PROJECT_ID,
        name: z.string().describe("Module block to change."),
        values: z
          .array(z.object({ input: z.string(), value: z.string() }))
          .min(1)
          .describe("Inputs to set."),
      }),
      annotations: WRITES,
    },
    ({ projectId, name, values }) =>
      edit(projectId, { action: "set-arguments", name, values: [...values] }),
  );

  server.registerTool(
    "rename_module",
    {
      title: "Rename a module",
      description:
        "Change a module's block label and rewrite every reference to it in the same commit.",
      inputSchema: z.object({
        projectId: PROJECT_ID,
        name: z.string(),
        newName: z.string(),
      }),
      annotations: WRITES,
    },
    ({ projectId, name, newName }) =>
      edit(projectId, { action: "rename-module", name, newName }),
  );

  server.registerTool(
    "add_local",
    {
      title: "Add a variable",
      description:
        "Declare a named value in a `locals` block. The value is raw HCL, with the same quoting rules as set_module_arguments. Pass connectTo to wire it into a module input in the same commit.",
      inputSchema: z.object({
        projectId: PROJECT_ID,
        name: z
          .string()
          .describe("Variable name: letters, digits and underscores."),
        value: z.string().describe("HCL expression or plain value."),
        connectTo: z
          .object({ target: z.string(), targetInput: z.string() })
          .optional()
          .describe("Module input to feed with this variable."),
      }),
      annotations: WRITES,
    },
    ({ projectId, name, value, connectTo }) =>
      edit(projectId, {
        action: "add-local",
        name,
        value,
        ...(connectTo ? { connectTo } : {}),
      }),
  );

  server.registerTool(
    "set_local",
    {
      title: "Set a variable's value",
      description: "Change what a variable in the `locals` block holds.",
      inputSchema: z.object({
        projectId: PROJECT_ID,
        name: z.string(),
        value: z.string(),
      }),
      annotations: WRITES,
    },
    ({ projectId, name, value }) =>
      edit(projectId, { action: "set-local", name, value }),
  );

  server.registerTool(
    "remove_local",
    {
      title: "Remove a variable",
      description:
        "Delete a variable and every module argument that read it, so the configuration still plans. Destructive.",
      inputSchema: z.object({ projectId: PROJECT_ID, name: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    ({ projectId, name }) => edit(projectId, { action: "remove-local", name }),
  );

  // ---- Decisions ----------------------------------------------------------

  server.registerTool(
    "record_decision",
    {
      title: "Record a decision",
      description:
        "Write down what you decided and why, before building it. Everything you change afterwards is filed under this, so the project log can explain months later why the infrastructure looks the way it does. Use it for anything beyond a single edit, and also when you decide *not* to do something. Write `context` as your reading of the requirements, not as fact, so the person can correct it.",
      inputSchema: z.object({
        projectId: PROJECT_ID,
        question: z
          .string()
          .describe(
            "What is being decided, as a heading, e.g. `Where the application's data lives`.",
          ),
        context: z
          .string()
          .describe("The requirements you are working from, as you read them."),
        choice: z.string().describe("What you decided."),
        reason: z
          .string()
          .describe("Why, in terms the person can disagree with."),
        alternatives: z
          .array(z.object({ option: z.string(), reason: z.string() }))
          .default([])
          .describe("What you considered and rejected, each with its reason."),
      }),
      annotations: WRITES,
    },
    async ({ projectId, question, context, choice, reason, alternatives }) => {
      const denied = readOnlyRefusal();
      if (denied) return denied;

      const project = await findOwnedProject(caller.userId, projectId);
      if (!project) return refuse(`No project ${projectId}.`);

      const id = await recordDecision(project.id, "mcp", {
        question,
        context,
        choice,
        reason,
        alternatives: [...alternatives],
        // Empty plan. The field exists so our own agent can announce edits it is about
        // to queue within the same turn; an outside caller has no queue — it makes each
        // edit as its own call — so a plan here would be a promise nothing keeps.
        plan: { modules: [], wiring: [] },
      });

      return json({ decisionId: id });
    },
  );

  // ---- Deploy -------------------------------------------------------------

  server.registerTool(
    "get_deploy_state",
    {
      title: "Get the deployment state",
      description:
        "Whether this project can deploy: which AWS account and region it targets, whether the OIDC role and Terraform state bucket exist, whether the workflow files are committed, and what is still missing. Read this before run_deploy — a dispatch with settings missing fails a minute later in GitHub rather than here.",
      inputSchema: z.object({ projectId: PROJECT_ID }),
      annotations: READ_ONLY,
    },
    async ({ projectId }) => {
      const opened = await open(projectId);
      if (!opened.ok) return refuse(opened.error);

      const state = await readDeployState(opened.token, opened.project);

      return json({
        ...state,
        missing: missingDeploySettings({
          awsAccountId: opened.project.awsAccountId,
          awsRegion: opened.project.awsRegion,
          awsRoleArn: opened.project.awsRoleArn,
          stateBucket: opened.project.stateBucket,
          stateKmsKeyArn: opened.project.stateKmsKeyArn,
        }),
      });
    },
  );

  server.registerTool(
    "run_deploy",
    {
      title: "Start a Terraform run",
      description:
        "Dispatch the plan or apply workflow on GitHub Actions. Terrablox holds no AWS credentials — the workflow federates into the account for the length of the job, so every change leaves a run log in GitHub. `plan` is safe and shows what would change. `apply` changes real infrastructure and costs real money, so it requires `confirm` set to the project's exact name.",
      inputSchema: z.object({
        projectId: PROJECT_ID,
        workflow: z.enum(["plan", "apply"]),
        confirm: z
          .string()
          .optional()
          .describe(
            "For `apply` only: the project's exact name, as a deliberate second step.",
          ),
      }),
      annotations: WRITES,
    },
    async ({ projectId, workflow, confirm }) => {
      const denied = readOnlyRefusal();
      if (denied) return denied;

      const opened = await open(projectId);
      if (!opened.ok) return refuse(opened.error);
      const { project, token } = opened;

      // Typing the name back, the way GitHub asks before it deletes a repository. An
      // agent that has misunderstood which project it is working on fails this, and a
      // person reading the transcript sees the name it believed it was applying to.
      if (workflow === "apply" && confirm !== project.name) {
        return refuse(
          `Refusing to apply. This changes real infrastructure in AWS, so call again with confirm set to the project's exact name ("${project.name}"). Run \`plan\` first if you want to see what would change.`,
        );
      }

      const missing = missingDeploySettings({
        awsAccountId: project.awsAccountId,
        awsRegion: project.awsRegion,
        awsRoleArn: project.awsRoleArn,
        stateBucket: project.stateBucket,
        stateKmsKeyArn: project.stateKmsKeyArn,
      });

      if (missing.length > 0) {
        return refuse(
          `This project cannot deploy yet — still missing: ${missing.join(", ")}. Finish the deployment setup in the dashboard first.`,
        );
      }

      const template = findTemplate(workflow);
      if (!template) return refuse("That workflow is not in the catalogue.");

      try {
        await dispatchWorkflow(token, {
          repoFullName: project.repoFullName,
          workflowFile: template.path,
          ref: project.repoBranch,
        });
      } catch (error) {
        return refuse(
          error instanceof Error
            ? error.message
            : "The workflow could not be started.",
        );
      }

      // The same audit row the button writes, so the trail does not distinguish a
      // deploy by how it was started when asking who started one.
      await audit({
        action: "deploy.run.started",
        userId: caller.userId,
        subject: project.id,
        detail: {
          workflow,
          repo: project.repoFullName,
          via: "mcp",
          ...(caller.tokenId ? { tokenId: caller.tokenId } : {}),
        },
      });

      return json({
        started: true,
        workflow,
        repo: project.repoFullName,
        branch: project.repoBranch,
        note: "Follow the run in GitHub Actions; it federates into AWS on its own.",
      });
    },
  );

  // ---- Project and module lifecycle ---------------------------------------

  server.registerTool(
    "delete_project",
    {
      title: "Delete a project",
      description:
        "Delete a project, its graph history, its transcript and its decisions. The GitHub repository is NOT deleted — the Terraform stays where it is. Irreversible on our side, so it requires `confirm` set to the project's exact name.",
      inputSchema: z.object({
        projectId: PROJECT_ID,
        confirm: z.string().describe("The project's exact name."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ projectId, confirm }) => {
      const denied = readOnlyRefusal();
      if (denied) return denied;

      const project = await findOwnedProject(caller.userId, projectId);
      if (!project) return refuse(`No project ${projectId}.`);

      if (confirm !== project.name) {
        return refuse(
          `Refusing to delete. Call again with confirm set to "${project.name}".`,
        );
      }

      await database.project.delete({ where: { id: project.id } });

      await audit({
        action: "project.deleted",
        userId: caller.userId,
        subject: project.id,
        detail: { name: project.name, repo: project.repoFullName, via: "mcp" },
      });

      return json({
        deleted: true,
        note: `The repository ${project.repoFullName} still exists and still holds the Terraform.`,
      });
    },
  );

  server.registerTool(
    "import_module",
    {
      title: "Import a module from Git",
      description:
        "Add a Terraform module to this account's library by reading a Git repository at a tag or branch, analysing its variables, outputs and resources. Pin a tag rather than a branch: a branch means the module's interface can change under a project that already uses it.",
      inputSchema: z.object({
        repoFullName: z
          .string()
          .describe("e.g. `terraform-aws-modules/terraform-aws-vpc`."),
        refType: z.enum(["tag", "branch"]),
        refName: z.string().describe("The tag or branch name."),
        terraformRootFolder: z
          .string()
          .optional()
          .describe("Folder holding the root module. Detected when omitted."),
        nameOverride: z
          .string()
          .optional()
          .describe("What to call it in the library."),
      }),
      annotations: WRITES,
    },
    async ({
      repoFullName,
      refType,
      refName,
      terraformRootFolder,
      nameOverride,
    }) => {
      const denied = readOnlyRefusal();
      if (denied) return denied;

      const token = await githubTokenForUser(caller.userId);
      if (!token) {
        return refuse(
          "No GitHub token for this account. Link GitHub in the dashboard.",
        );
      }

      try {
        const result = await importModuleFromGit({
          userId: caller.userId,
          token,
          repoFullName,
          refType,
          refName,
          ...(terraformRootFolder !== undefined ? { terraformRootFolder } : {}),
          ...(nameOverride !== undefined ? { nameOverride } : {}),
        });

        return json(result);
      } catch (error) {
        return refuse(
          error instanceof Error
            ? error.message
            : "The module could not be imported.",
        );
      }
    },
  );

  server.registerTool(
    "connect_local",
    {
      title: "Wire a variable into an input",
      description:
        "Point a module's input at a variable declared in the `locals` block.",
      inputSchema: z.object({
        projectId: PROJECT_ID,
        local: z.string(),
        target: z.string(),
        targetInput: z.string(),
      }),
      annotations: WRITES,
    },
    ({ projectId, local, target, targetInput }) =>
      edit(projectId, {
        action: "connect-local",
        local,
        target,
        targetInput,
      }),
  );

  return server;
}
