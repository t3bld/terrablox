"use client";

import { Badge } from "@terrablox/ui/badge";
import { Button } from "@terrablox/ui/button";
import { Input } from "@terrablox/ui/input";
import {
  Check,
  ExternalLink,
  PanelRightClose,
  Pencil,
  Sparkles,
  Trash2,
  Unlink,
  X,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import type {
  ProjectGraph,
  ProjectGraphMutation,
  ProjectGraphNode,
  ProjectGraphPort,
} from "@/lib/projects/types";
import { MIN_WIRING_SCORE, wiringScore } from "@/lib/projects/wiring";

interface ModuleInspectorProps {
  node: ProjectGraphNode;
  graph: ProjectGraph;
  busy: boolean;
  onMutate: (mutation: ProjectGraphMutation) => void;
  onClose: () => void;
  /** Hides the whole pane, as opposed to `onClose` which returns to the chat. */
  onCollapse?: () => void;
}

/** One selectable `module.<node>.<output>` reference. */
interface SourceOption {
  node: string;
  output: string;
  score: number;
}

/**
 * Configuration surface for the module the user clicked on the canvas.
 *
 * The canvas can only express what a wire looks like; everything else a module
 * needs — an instance type, a CIDR, a name prefix — has no shape on a graph.
 * This panel is where those live, next to the wires, so a module can be brought
 * into a working state without leaving for the file editor.
 */
export function ModuleInspector({
  node,
  graph,
  busy,
  onMutate,
  onClose,
  onCollapse,
}: ModuleInspectorProps) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [showOptional, setShowOptional] = useState(false);

  const sources = useMemo<SourceOption[]>(
    () =>
      graph.nodes
        .filter((other) => other.id !== node.id)
        .flatMap((other) =>
          other.outputs.map((output) => ({
            node: other.id,
            output: output.name,
            score: 0,
          })),
        ),
    [graph.nodes, node.id],
  );

  const ports = useMemo(() => orderPorts(node), [node]);
  const missing = ports.filter(
    (port) => port.required && !(port.name in node.values),
  );
  const optional = ports.filter((port) => rank(port, node) === 3);
  const visible = showOptional
    ? ports
    : ports.filter((port) => rank(port, node) !== 3);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-start gap-2 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          {renaming === null ? (
            <div className="flex items-center gap-1">
              <h2 className="truncate font-semibold">{node.label}</h2>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0"
                disabled={busy}
                onClick={() => setRenaming(node.label)}
                aria-label="Rename module"
              >
                <Pencil className="h-3 w-3" />
              </Button>
            </div>
          ) : (
            <form
              className="flex items-center gap-1"
              onSubmit={(event) => {
                event.preventDefault();
                const newName = renaming.trim();
                setRenaming(null);
                if (newName && newName !== node.label) {
                  onMutate({
                    action: "rename-module",
                    name: node.label,
                    newName,
                  });
                }
              }}
            >
              {/* Focus is safe here: the field only appears on an explicit rename click. */}
              <Input
                autoFocus
                value={renaming}
                onChange={(event) => setRenaming(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setRenaming(null);
                }}
                className="h-7 text-sm"
                aria-label="Module name"
              />
              <Button
                type="submit"
                variant="ghost"
                size="icon"
                className="h-7 w-7"
              >
                <Check className="h-3.5 w-3.5" />
              </Button>
            </form>
          )}

          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {node.moduleName ?? node.source ?? "unknown source"}
            {node.version ? ` · ${node.version}` : ""}
          </p>
        </div>

        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={onClose}
          aria-label="Back to the agent"
        >
          <X className="h-4 w-4" />
        </Button>

        {onCollapse ? (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={onCollapse}
            aria-label="Collapse panel"
          >
            <PanelRightClose className="h-4 w-4" />
          </Button>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {node.moduleId ? (
          <Link
            href={`/modules/${node.moduleId}`}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Open module documentation
            <ExternalLink className="h-3 w-3" />
          </Link>
        ) : (
          <p className="rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
            This block is not linked to a module in your library, so its inputs
            and outputs are unknown. Only the arguments already written in the
            file are shown.
          </p>
        )}

        {missing.length > 0 ? (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
            <p className="text-xs">
              <span className="font-medium">
                {missing.length} required input
                {missing.length === 1 ? "" : "s"}
              </span>{" "}
              still {missing.length === 1 ? "has" : "have"} no value.
            </p>
            {sources.length > 0 ? (
              <Button
                variant="outline"
                size="sm"
                className="mt-2 h-7 gap-1 text-xs"
                disabled={busy}
                onClick={() =>
                  onMutate({ action: "auto-connect", name: node.label })
                }
              >
                <Sparkles className="h-3 w-3" />
                Wire from canvas
              </Button>
            ) : null}
          </div>
        ) : null}

        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Inputs
          </h3>

          {visible.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No arguments are set on this module.
            </p>
          ) : (
            <ul className="space-y-2">
              {visible.map((port) => (
                <InputRow
                  key={port.name}
                  label={node.label}
                  port={port}
                  value={node.values[port.name] ?? null}
                  sources={sources}
                  busy={busy}
                  onMutate={onMutate}
                />
              ))}
            </ul>
          )}

          {optional.length > 0 && !showOptional ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setShowOptional(true)}
            >
              Show {optional.length} optional input
              {optional.length === 1 ? "" : "s"}
            </Button>
          ) : null}
        </section>

        {node.outputs.length > 0 ? (
          <section className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Outputs
            </h3>
            <ul className="flex flex-wrap gap-1">
              {node.outputs.map((output) => (
                <li key={output.name}>
                  <Badge variant="secondary" className="font-mono text-[11px]">
                    {output.name}
                  </Badge>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
          disabled={busy}
          onClick={() =>
            onMutate({ action: "remove-module", name: node.label })
          }
        >
          <Trash2 className="h-3.5 w-3.5" />
          Remove module
        </Button>
      </div>
    </div>
  );
}

interface InputRowProps {
  label: string;
  port: ProjectGraphPort;
  value: string | null;
  sources: SourceOption[];
  busy: boolean;
  onMutate: (mutation: ProjectGraphMutation) => void;
}

function InputRow({
  label,
  port,
  value,
  sources,
  busy,
  onMutate,
}: InputRowProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const wired = value?.startsWith("module.") ?? false;

  // Matching outputs float to the top of the picker; a `vpc_id` input has one
  // plausible source and dozens of implausible ones, and scrolling past the
  // implausible ones is the whole friction this panel exists to remove.
  const options = useMemo(
    () =>
      sources
        .map((source) => ({
          ...source,
          score: wiringScore(port.name, source.output, source.node),
        }))
        .sort(
          (a, b) =>
            b.score - a.score ||
            a.node.localeCompare(b.node) ||
            a.output.localeCompare(b.output),
        ),
    [sources, port.name],
  );

  return (
    <li className="rounded-md border p-2">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-xs">{port.name}</span>
        {port.required ? (
          <span className="text-[10px] uppercase text-amber-600">required</span>
        ) : null}
        {port.type ? (
          <span className="ml-auto truncate text-[10px] text-muted-foreground">
            {port.type}
          </span>
        ) : null}
      </div>

      {draft !== null ? (
        <form
          className="mt-1.5 flex items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            const next = draft;
            setDraft(null);
            onMutate({
              action: "set-argument",
              name: label,
              input: port.name,
              value: next,
            });
          }}
        >
          {/* Focus is safe here: the field replaces the button just pressed. */}
          <Input
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setDraft(null);
            }}
            placeholder="t3.micro or var.instance_type"
            className="h-7 font-mono text-xs"
            aria-label={`Value for ${port.name}`}
          />
          <Button type="submit" variant="ghost" size="icon" className="h-7 w-7">
            <Check className="h-3.5 w-3.5" />
          </Button>
        </form>
      ) : (
        <div className="mt-1.5 flex items-center gap-1">
          {value === null ? (
            <span className="flex-1 text-xs text-muted-foreground">
              Not set
            </span>
          ) : (
            <code
              className={`min-w-0 flex-1 truncate rounded px-1 py-0.5 text-[11px] ${
                wired ? "bg-primary/10 text-primary" : "bg-muted"
              }`}
              title={value}
            >
              {value}
            </code>
          )}

          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            disabled={busy}
            onClick={() => setDraft(value ?? "")}
            aria-label={`Edit ${port.name}`}
          >
            <Pencil className="h-3 w-3" />
          </Button>

          {value !== null ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              disabled={busy}
              onClick={() =>
                onMutate({
                  action: "disconnect",
                  target: label,
                  targetInput: port.name,
                })
              }
              aria-label={`Clear ${port.name}`}
            >
              <Unlink className="h-3 w-3" />
            </Button>
          ) : null}
        </div>
      )}

      {options.length > 0 && draft === null ? (
        <select
          value=""
          disabled={busy}
          onChange={(event) => {
            const [source, output] = event.target.value.split("\u0000");
            if (!source || !output) return;
            onMutate({
              action: "connect",
              source,
              sourceOutput: output,
              target: label,
              targetInput: port.name,
            });
          }}
          className="mt-1.5 w-full rounded-md border bg-background px-2 py-1 text-xs text-muted-foreground"
          aria-label={`Connect ${port.name} to a module output`}
        >
          <option value="">Connect from…</option>
          {options.map((option) => (
            <option
              key={`${option.node}.${option.output}`}
              value={`${option.node}\u0000${option.output}`}
            >
              {option.score >= MIN_WIRING_SCORE ? "★ " : ""}
              module.{option.node}.{option.output}
            </option>
          ))}
        </select>
      ) : null}
    </li>
  );
}

/**
 * Unset requirements first, then everything the user has already touched.
 *
 * A module's variable list is alphabetical, which puts the one thing blocking a
 * `terraform plan` wherever the alphabet happens to place it.
 */
function orderPorts(node: ProjectGraphNode): ProjectGraphPort[] {
  const ports: ProjectGraphPort[] = [...node.inputs];

  // Arguments written by hand, or by the agent, that the library does not know
  // about — hiding them would make the panel lie about the file's contents.
  for (const name of Object.keys(node.values)) {
    if (!ports.some((port) => port.name === name)) {
      ports.push({ name, description: null });
    }
  }

  return ports.sort(
    (a, b) => rank(a, node) - rank(b, node) || a.name.localeCompare(b.name),
  );
}

function rank(port: ProjectGraphPort, node: ProjectGraphNode): number {
  const isSet = port.name in node.values;
  if (port.required && !isSet) return 0;
  if (port.required) return 1;
  return isSet ? 2 : 3;
}
