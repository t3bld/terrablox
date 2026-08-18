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

import type { ProjectOperationDto } from "@/lib/projects/types";

/** The action names in the words the canvas uses. */
const ACTION_LABELS: Record<string, string> = {
  "add-module": "Added",
  "remove-module": "Removed",
  connect: "Connected",
  disconnect: "Disconnected",
  "rename-module": "Renamed",
  "set-argument": "Set input",
  "auto-connect": "Auto-connected",
};

/**
 * Every change this project has been through, newest first.
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
    <div className="space-y-4 p-6">
      {operations.length === 0 ? (
        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          Nothing yet. Add a module on the canvas or ask the agent for one.
        </p>
      ) : (
        <ol className="space-y-2">
          {operations.map((operation) => (
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
                    {ACTION_LABELS[operation.action] ?? operation.action}
                  </Badge>
                  <span className="text-sm">{operation.summary}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {new Date(operation.createdAt).toLocaleString()}
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
      )}
    </div>
  );
}
