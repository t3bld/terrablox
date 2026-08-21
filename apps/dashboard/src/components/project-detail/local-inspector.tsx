"use client";

import { Button } from "@terrablox/ui/button";
import { Input } from "@terrablox/ui/input";
import { Label } from "@terrablox/ui/label";
import { Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  isValidLocalName,
  localReference,
  localValueKind,
} from "@/lib/projects/locals";
import type { ProjectGraph, ProjectGraphNode } from "@/lib/projects/types";

interface LocalInspectorProps {
  node: ProjectGraphNode;
  graph: ProjectGraph;
  busy: boolean;
  onRename: (newName: string) => void;
  onSetValue: (value: string) => void;
  onRemove: () => void;
  /** Omitted inside a dialog, which brings its own close. */
  onClose?: () => void;
}

/**
 * A named value, in full.
 *
 * Values are created and picked at the input that reads them, which covers
 * everything except the two questions an input cannot answer: what else reads
 * this, and should it still exist. A value with no readers is dead
 * configuration, and a value with five is one worth renaming carefully.
 */
export function LocalInspector({
  node,
  graph,
  busy,
  onRename,
  onSetValue,
  onRemove,
  onClose,
}: LocalInspectorProps) {
  const [name, setName] = useState(node.id);
  const [value, setValue] = useState(node.expression ?? "");
  const [confirmRemove, setConfirmRemove] = useState(false);

  // The graph is re-read after every commit, so the fields follow the node when
  // it changes underneath — including when the agent is the one changing it.
  useEffect(() => {
    setName(node.id);
    setValue(node.expression ?? "");
    setConfirmRemove(false);
  }, [node.id, node.expression]);

  const readers = useMemo(
    () =>
      graph.edges
        .filter(
          (edge) => edge.sourceKind === "local" && edge.source === node.id,
        )
        .flatMap((edge) =>
          edge.links.map((link) => ({
            target: edge.target,
            targetInput: link.targetInput,
          })),
        ),
    [graph.edges, node.id],
  );

  const nameChanged = name.trim() !== node.id;
  const valueChanged = value.trim() !== (node.expression ?? "").trim();
  const nameValid = isValidLocalName(name);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-start gap-2 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold">{node.id}</h2>
          <p className="mt-0.5 truncate font-mono text-muted-foreground text-xs">
            {localReference(node.id)} · {localValueKind(node.expression)}
          </p>
        </div>

        {onClose ? (
          <Button
            aria-label="Close value details"
            className="h-7 w-7 shrink-0"
            onClick={onClose}
            size="icon"
            variant="ghost"
          >
            <X className="h-4 w-4" />
          </Button>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <div className="grid gap-2">
          <Label htmlFor="local-name">Name</Label>
          <Input
            className="font-mono text-sm"
            disabled={busy}
            id="local-name"
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
          {name.trim() !== "" && !nameValid ? (
            <p className="text-destructive text-xs">
              Letters, digits and underscores only, starting with a letter.
            </p>
          ) : (
            <p className="text-muted-foreground text-xs">
              Renaming rewrites every {localReference(node.id)} that reads it.
            </p>
          )}
          {nameChanged && nameValid ? (
            <Button
              className="w-fit"
              disabled={busy}
              onClick={() => onRename(name.trim())}
              size="sm"
              variant="outline"
            >
              Rename
            </Button>
          ) : null}
        </div>

        <div className="grid gap-2">
          <Label htmlFor="local-value">Value</Label>
          {/* A textarea rather than an input: a local is often a `merge(…)` or a
              conditional that does not fit on one line, and wrapping it is the
              difference between reviewable and not. */}
          <textarea
            className="min-h-24 w-full resize-y rounded-md border bg-background px-3 py-2 font-mono text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
            disabled={busy}
            id="local-value"
            onChange={(event) => setValue(event.target.value)}
            spellCheck={false}
            value={value}
          />
          <p className="text-muted-foreground text-xs">
            Written as HCL. A bare word is quoted for you; anything that looks
            like an expression —{" "}
            <code className="rounded bg-muted px-1">module.vpc.id</code>,{" "}
            <code className="rounded bg-muted px-1">[80, 443]</code> — is kept
            as written.
          </p>
          {valueChanged ? (
            <Button
              className="w-fit"
              disabled={busy}
              onClick={() => onSetValue(value)}
              size="sm"
            >
              Save value
            </Button>
          ) : null}
        </div>

        <div className="space-y-2">
          <h3 className="font-medium text-sm">
            Read by {readers.length} {readers.length === 1 ? "input" : "inputs"}
          </h3>
          {readers.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              Nothing reads this value yet. Drag from its dot into a module
              input, or delete it.
            </p>
          ) : (
            <ul className="space-y-1">
              {readers.map((reader) => (
                <li
                  className="truncate rounded-md border px-2 py-1 font-mono text-xs"
                  key={`${reader.target}.${reader.targetInput}`}
                >
                  {reader.target}.{reader.targetInput}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="border-t p-4">
        {confirmRemove ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              disabled={busy}
              onClick={onRemove}
              size="sm"
              variant="destructive"
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              Delete and clear {readers.length}{" "}
              {readers.length === 1 ? "reference" : "references"}
            </Button>
            <Button
              onClick={() => setConfirmRemove(false)}
              size="sm"
              variant="ghost"
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            disabled={busy}
            onClick={() => setConfirmRemove(true)}
            size="sm"
            variant="outline"
          >
            <Trash2 className="mr-2 h-3.5 w-3.5" />
            Delete this value
          </Button>
        )}
      </div>
    </div>
  );
}
