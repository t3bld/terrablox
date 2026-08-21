"use client";

import { Badge } from "@terrablox/ui/badge";
import { Skeleton } from "@terrablox/ui/skeleton";
import {
  AlertCircle,
  Bot,
  ExternalLink,
  GitCommit,
  MousePointer2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { PROJECT_AGENT_TOOLS } from "@/lib/agent/tool-catalogue";
import type { ProjectOperationDto } from "@/lib/projects/types";

/**
 * Mutation names to the operation they belong to.
 *
 * The label itself comes from the operation catalogue, so the history says
 * "Edit Module" exactly as the agent settings do. It used to have words of its
 * own — "Added", "Renamed" — which meant the same edit was called two different
 * things depending on which screen you were looking at.
 *
 * A mutation is not always a whole operation: `edit_module` queues a
 * `set-argument` and a `rename-module`, and both belong to it. That is why this
 * maps to a tool name rather than reusing one.
 */
const ACTION_TOOLS: Record<string, string> = {
  "add-module": "add_module",
  "remove-module": "remove_module",
  connect: "connect",
  disconnect: "disconnect",
  "rename-module": "edit_module",
  "set-argument": "edit_module",
  "add-local": "add_local",
  "remove-local": "remove_local",
  "connect-local": "connect_local",
  "set-local": "edit_local",
  "rename-local": "edit_local",
};

/** Not an operation the agent has: the canvas fills gaps by itself. */
const CANVAS_ONLY_LABELS: Record<string, string> = {
  "auto-connect": "Auto-connect",
};

function actionLabel(action: string): string {
  const tool = ACTION_TOOLS[action];
  const operation = tool
    ? PROJECT_AGENT_TOOLS.find((entry) => entry.name === tool)
    : undefined;

  return operation?.label ?? CANVAS_ONLY_LABELS[action] ?? action;
}

/**
 * The operations of one day, in the order they arrived (newest first).
 *
 * `key` is the local calendar date, which is what the grouping is keyed on rather
 * than the ISO date: an edit made at half past midnight belongs to the day the
 * user remembers making it, not to the previous UTC day.
 */
interface DayGroup {
  key: string;
  date: Date;
  operations: ProjectOperationDto[];
}

/** The local calendar day of a timestamp, as a stable key. */
function dayKeyOf(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/**
 * Buckets the operations by day, preserving the order they came in.
 *
 * Relies on the server sending them newest first: groups are appended as new days
 * appear, so the output is in the same order without a second sort.
 */
function groupByDay(operations: ProjectOperationDto[]): DayGroup[] {
  const groups: DayGroup[] = [];

  for (const operation of operations) {
    const date = new Date(operation.createdAt);
    const key = dayKeyOf(date);
    const current = groups.at(-1);

    if (current?.key === key) {
      current.operations.push(operation);
      continue;
    }

    groups.push({ key, date, operations: [operation] });
  }

  return groups;
}

/**
 * A day heading: "Today", "Yesterday", or the date written out.
 *
 * The two relative names carry their weight — most of what anyone reads here
 * happened in the current session, and "Today" is faster to recognise than a date
 * you have to compare against today's.
 */
function dayLabel(date: Date): string {
  const today = new Date();
  const key = dayKeyOf(date);

  if (key === dayKeyOf(today)) return "Today";

  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (key === dayKeyOf(yesterday)) return "Yesterday";

  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    // A year only where it is not the current one; on a project started this
    // month it is the same four digits on every heading.
    ...(date.getFullYear() === today.getFullYear()
      ? { weekday: "long" }
      : { year: "numeric" }),
  });
}

/**
 * Every change this project has been through, newest first, grouped by day.
 *
 * Each entry names the commit it produced and the one it replaced, so the list
 * is also the map for going back to a point in time. Jumping is not wired up
 * yet; the anchors are recorded so that it can be, without a migration.
 */
export function HistoryPanel({ projectId }: { projectId: string }) {
  const [operations, setOperations] = useState<ProjectOperationDto[] | null>(
    null,
  );
  const [repo, setRepo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch(`/api/projects/${projectId}/operations`);
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(body?.error ?? `Request failed (${response.status})`);
    }
    return body as { operations: ProjectOperationDto[]; repoFullName: string };
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;

    load()
      .then((body) => {
        if (cancelled) return;
        setOperations(body.operations);
        setRepo(body.repoFullName);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Could not load the history.",
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [load]);

  if (error) {
    return (
      <p className="flex items-center gap-2 p-6 text-sm text-destructive">
        <AlertCircle className="h-4 w-4 shrink-0" />
        {error}
      </p>
    );
  }

  if (!operations) return <Skeleton className="m-6 h-64" />;

  return (
    <div className="space-y-6 p-6">
      {operations.length === 0 ? (
        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          Nothing yet. Add a module on the canvas or ask the agent for one.
        </p>
      ) : (
        groupByDay(operations).map((group) => (
          <section className="space-y-2" key={group.key}>
            {/* Sticky so the day stays readable while scrolling a long session,
                which is the only reason to group at all. */}
            <h3 className="sticky top-0 z-10 -mx-6 bg-background/95 px-6 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground backdrop-blur">
              {dayLabel(group.date)}
              <span className="ml-2 normal-case tracking-normal opacity-70">
                {group.operations.length}{" "}
                {group.operations.length === 1 ? "change" : "changes"}
              </span>
            </h3>

            {/* Three across on a wide screen. An entry is a short badge, a line
                of summary and a commit hash, so one per row left most of the
                width empty and turned a working session into a long scroll. */}
            <ol className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {group.operations.map((operation) => (
                <li
                  className="flex items-start gap-3 rounded-md border p-3"
                  key={operation.id}
                >
                  <span
                    className="mt-0.5 text-muted-foreground"
                    title={
                      operation.origin === "agent"
                        ? "Made by the agent"
                        : "Made on the canvas"
                    }
                  >
                    {operation.origin === "agent" ? (
                      <Bot className="h-4 w-4" />
                    ) : (
                      <MousePointer2 className="h-4 w-4" />
                    )}
                  </span>

                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">
                        {actionLabel(operation.action)}
                      </Badge>
                      <span className="text-sm">{operation.summary}</span>
                    </div>
                    {/* The day is in the heading above, so the row only needs
                        the time of day. */}
                    <p className="text-xs text-muted-foreground">
                      {new Date(operation.createdAt).toLocaleTimeString(
                        undefined,
                        { hour: "2-digit", minute: "2-digit" },
                      )}
                    </p>
                  </div>

                  {operation.commitSha && repo ? (
                    <a
                      className="flex shrink-0 items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground"
                      href={`https://github.com/${repo}/commit/${operation.commitSha}`}
                      rel="noreferrer"
                      target="_blank"
                    >
                      <GitCommit className="h-3 w-3" />
                      {operation.commitSha.slice(0, 7)}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  ) : (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      no commit
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </section>
        ))
      )}
    </div>
  );
}
