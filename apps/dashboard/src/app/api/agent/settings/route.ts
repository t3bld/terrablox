import { AGENT_KNOWLEDGE } from "@terrablox/agent-harness/knowledge";
import { PROJECT_AGENT_TOOLS } from "@terrablox/agent-harness/tool-catalogue";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  AgentSettingsError,
  getAgentSettings,
  saveAgentSettings,
  setAgentAllowDestructive,
  setAgentDisabledKnowledge,
  setAgentDisabledTools,
  setAgentRuntime,
} from "@/lib/agent/settings-service";
import { parseJsonBody } from "@/lib/api/guard";
import { routeError } from "@/lib/api/route-error";
import { getCurrentUserId } from "@/lib/auth/server-helpers";

/**
 * The user's own agent settings, plus the catalogue they can choose from.
 *
 * Catalogue and selection travel together because the UI cannot render one
 * without the other, and shipping them separately would let the page show
 * switches for sources that no longer exist.
 */
export async function GET() {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await getAgentSettings(userId);

  return NextResponse.json({
    ...settings,
    catalogue: AGENT_KNOWLEDGE.map(({ id, name, description }) => ({
      id,
      name,
      description,
    })),
    toolCatalogue: PROJECT_AGENT_TOOLS.map(
      ({ name, group, label, summary }) => ({
        name,
        group,
        label,
        summary,
      }),
    ),
  });
}

export async function PUT(request: Request) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // `instructions` goes into the agent's system prompt, so the cap matters for the
  // same reason the chat message cap does: it is persisted and then spent on a model.
  // The service enforces its own limit too; this is what stops an unbounded body being
  // buffered before that limit applies.
  let instructions: string;
  try {
    const body = await parseJsonBody(
      request,
      z.object({ instructions: z.string().max(20_000).optional().default("") }),
    );
    instructions = body.instructions;
  } catch (error) {
    return routeError("agent.settings", error);
  }

  try {
    await saveAgentSettings(userId, { instructions });
    return NextResponse.json(await getAgentSettings(userId));
  } catch (error) {
    if (error instanceof AgentSettingsError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    // The dev server's log is the only place this is visible, so say enough to
    // be findable there rather than only in the browser.
    console.error("[agent] failed to save settings", error);
    return NextResponse.json(
      { error: "Could not save your settings. Check the server log." },
      { status: 500 },
    );
  }
}

/**
 * Everything except the instruction text: the deny lists and the runtime choices.
 *
 * Separate from PUT because the views that send these never hold the instructions,
 * and a PUT carrying an empty string would wipe what the user wrote on the
 * settings screen.
 *
 * Each field is optional and only the ones present are written, so one dropdown
 * can be saved without the caller having to send the state of the others.
 */
export async function PATCH(request: Request) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    disabledKnowledge?: unknown;
    disabledTools?: unknown;
    model?: unknown;
    reasoningEffort?: unknown;
    turnTimeout?: unknown;
    maxToolCalls?: unknown;
    maxMcpCalls?: unknown;
    historyBudgetChars?: unknown;
    maxSteps?: unknown;
    maxAppRepoReads?: unknown;
    appRepoTreeLimit?: unknown;
    appRepoFileChars?: unknown;
    allowDestructive?: unknown;
  };

  // The numeric budgets are each clamped to their own min/max by `setAgentRuntime`,
  // and the id lists are checked against the known catalogues, so the shape check here
  // exists for the body-size cap rather than to re-state those rules.
  try {
    body = await parseJsonBody(
      request,
      z.record(z.string().max(100), z.unknown()),
    );
  } catch (error) {
    return routeError("agent.settings", error);
  }

  const strings = (value: unknown) =>
    Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : null;

  const disabledKnowledge = strings(body.disabledKnowledge);
  const disabledTools = strings(body.disabledTools);

  // Read with `in` rather than by truthiness: null is a real value for all three
  // and means "use the default", which is not the same as "not mentioned".
  const runtime: Parameters<typeof setAgentRuntime>[1] = {};
  if ("model" in body) runtime.model = body.model as string | null;
  if ("reasoningEffort" in body) {
    runtime.reasoningEffort = body.reasoningEffort as string | null;
  }
  if ("turnTimeout" in body) {
    runtime.turnTimeout = body.turnTimeout as number | string | null;
  }
  if ("maxToolCalls" in body) {
    runtime.maxToolCalls = body.maxToolCalls as number | string | null;
  }
  if ("maxMcpCalls" in body) {
    runtime.maxMcpCalls = body.maxMcpCalls as number | string | null;
  }
  if ("historyBudgetChars" in body) {
    runtime.historyBudgetChars = body.historyBudgetChars as
      | number
      | string
      | null;
  }

  if ("maxSteps" in body) {
    runtime.maxSteps = body.maxSteps as number | string | null;
  }

  if ("maxAppRepoReads" in body) {
    runtime.maxAppRepoReads = body.maxAppRepoReads as number | string | null;
  }

  if ("appRepoTreeLimit" in body) {
    runtime.appRepoTreeLimit = body.appRepoTreeLimit as number | string | null;
  }

  if ("appRepoFileChars" in body) {
    runtime.appRepoFileChars = body.appRepoFileChars as number | string | null;
  }

  const hasRuntime = Object.keys(runtime).length > 0;

  // Only a real boolean, so a truthy string cannot grant a permission.
  const allowDestructive =
    typeof body.allowDestructive === "boolean" ? body.allowDestructive : null;

  if (
    !disabledKnowledge &&
    !disabledTools &&
    !hasRuntime &&
    allowDestructive === null
  ) {
    return NextResponse.json(
      {
        error:
          "Send `disabledKnowledge`, `disabledTools`, `allowDestructive`, `model`, `reasoningEffort`, `turnTimeout`, `maxToolCalls`, `maxMcpCalls`, `historyBudgetChars`, `maxSteps`, `maxAppRepoReads`, `appRepoTreeLimit` or `appRepoFileChars`.",
      },
      { status: 400 },
    );
  }

  try {
    if (disabledKnowledge) {
      await setAgentDisabledKnowledge(userId, disabledKnowledge);
    }
    if (disabledTools) await setAgentDisabledTools(userId, disabledTools);
    if (allowDestructive !== null) {
      await setAgentAllowDestructive(userId, allowDestructive);
    }
    if (hasRuntime) await setAgentRuntime(userId, runtime);
    return NextResponse.json(await getAgentSettings(userId));
  } catch (error) {
    // A rejected value is the caller's fault, not a server fault, and the message
    // names the allowed range — worth returning as 400 rather than burying in the
    // 500 branch below.
    if (error instanceof AgentSettingsError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    console.error("[agent] failed to toggle setting", error);

    // The reason is returned rather than hidden behind "check the log". This is
    // a self-hosted tool whose operator is the person reading the message, and
    // the two realistic failures here — a pending migration and a stale Prisma
    // client — are both invisible from the UI but obvious from the text.
    const reason = error instanceof Error ? error.message : String(error);
    const pendingMigration =
      /disabledKnowledge|disabled_knowledge|Unknown argument|column .* does not exist/i.test(
        reason,
      );

    return NextResponse.json(
      {
        error: pendingMigration
          ? "The database is missing the agent knowledge column. Run: pnpm db:migrate && pnpm db:generate, then restart the dev server."
          : `Could not change that: ${reason}`,
      },
      { status: 500 },
    );
  }
}
