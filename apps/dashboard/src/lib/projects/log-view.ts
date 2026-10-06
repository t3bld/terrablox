/**
 * The log's shape, separate from its rendering.
 *
 * Grouping turns, flattening them into lines and filtering across both is the part
 * of the Logs panel with decisions in it — the numbering that has to survive new
 * turns arriving, the canvas gesture that is not a turn, the search that has to
 * reach inside something collapsed. Here so it can be checked without a browser.
 */

import type { ProjectLogTurnDto } from "./types";

/**
 * One line of the trajectory.
 *
 * `kind` drives the badge and nothing else; `detail` is what the panel shows when
 * the row is picked. Flattened up front rather than rendered from nested data,
 * because a flat list is what can be filtered, counted and keyboard-navigated
 * without every consumer re-deriving the same order.
 */
export interface Row {
  id: string;
  kind: "prompt" | "thought" | "tool" | "reply" | "canvas";
  /** Uppercase badge text: `USER`, `THOUGHT`, the tool name, `CANVAS`. */
  badge: string;
  /** The single line shown in the list. */
  line: string;
  ok: boolean;
  turn: ProjectLogTurnDto;
}

/**
 * A turn, and the lines it is made of.
 *
 * The grouping is the point. Flat, a turn that queued twenty-nine operations was
 * thirty-odd rows, and scrolling past one turn took the screen — so the log read as
 * a wall of tool calls with the questions lost inside it. A turn is the unit
 * somebody actually asks about ("what happened when I asked for the database"), so
 * it is the unit the list is made of, and its lines are underneath it.
 */
export interface TurnGroup {
  key: string;
  /** `Turn 4`, or absent for a canvas gesture, which is not a turn. */
  label?: string;
  turn: ProjectLogTurnDto;
  rows: Row[];
  /** Header counts, worked out once rather than in the render. */
  calls: number;
  thoughts: number;
  /** True when any step in the turn failed, so the header can say so. */
  failed: boolean;
  /** A canvas change: one line, nothing to expand, no prompt behind it. */
  canvas: boolean;
}

/** The lines of one turn, in the order they happened. */
export function rowsOfTurn(turn: ProjectLogTurnDto, key: string): Row[] {
  const rows: Row[] = [];

  if (turn.prompt !== null) {
    rows.push({
      id: `${key}-prompt`,
      kind: "prompt",
      badge: "user",
      line: turn.prompt,
      ok: true,
      turn,
    });
  }

  for (const [index, step] of turn.steps.entries()) {
    rows.push(
      step.kind === "thought"
        ? {
            id: `${key}-s${index}`,
            kind: "thought",
            badge: "thought",
            line: step.text,
            ok: true,
            turn,
          }
        : {
            id: `${key}-s${index}`,
            kind: "tool",
            badge: step.tool,
            line: step.summary,
            ok: step.ok,
            turn,
          },
    );
  }

  rows.push({
    id: `${key}-reply`,
    kind: "reply",
    badge: "reply",
    line: turn.reply ?? "",
    ok: true,
    turn,
  });

  return rows;
}

/**
 * Turns to groups, newest first and chronological within each.
 *
 * Newest first because a log is read from the top for what just happened; forward
 * within a turn because a turn is a story — the prompt, then the work, then the
 * answer — and reversing it would make every turn read backwards.
 */
export function toGroups(turns: ProjectLogTurnDto[]): TurnGroup[] {
  // Numbered from the oldest, so a turn keeps its number as newer ones arrive.
  const numberOf = new Map<string, number>();
  let counter = 0;
  for (const turn of [...turns].reverse()) {
    if (turn.chatMessageId) numberOf.set(turn.chatMessageId, ++counter);
  }

  return turns.map((turn) => {
    const key = turn.chatMessageId ?? `canvas-${turn.createdAt}`;

    if (!turn.chatMessageId) {
      const operation = turn.operations[0];
      return {
        key,
        turn,
        canvas: true,
        calls: 0,
        thoughts: 0,
        failed: false,
        rows: [
          {
            id: `${key}-canvas`,
            kind: "canvas" as const,
            badge: "canvas",
            line: operation?.summary ?? "Change",
            ok: true,
            turn,
          },
        ],
      };
    }

    const thoughts = turn.steps.filter(
      (step) => step.kind === "thought",
    ).length;

    return {
      key,
      label: `Turn ${numberOf.get(turn.chatMessageId)}`,
      turn,
      canvas: false,
      rows: rowsOfTurn(turn, key),
      calls: turn.steps.length - thoughts,
      thoughts,
      failed: turn.steps.some((step) => step.kind !== "thought" && !step.ok),
    };
  });
}

/**
 * The groups a query matches, with their non-matching lines dropped.
 *
 * A search has to be able to reach inside a collapsed turn, or it would only ever
 * find the prompts. So a turn survives if its prompt matches or any of its lines
 * does, and what is left of it is the lines that did.
 *
 * The exception is a turn matched by its prompt alone: it keeps all of its lines,
 * because the thing that matched was the turn, and showing none of its contents
 * would answer a different question than the one asked.
 */
export function filterGroups(groups: TurnGroup[], query: string): TurnGroup[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return groups;

  const hit = (text: string) => text.toLowerCase().includes(needle);

  return groups.flatMap((group) => {
    // Tested first, and returning early. The prompt is also one of the rows, so a
    // prompt match always matches at least that row — which meant the branch below
    // kept the prompt line and dropped the trail, the exact opposite of the intent.
    if (hit(group.turn.prompt ?? "")) return [group];

    const rows = group.rows.filter((row) => hit(row.badge) || hit(row.line));
    return rows.length ? [{ ...group, rows }] : [];
  });
}
