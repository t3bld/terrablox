"use client";

import { Badge } from "@terrablox/ui/badge";
import { Button } from "@terrablox/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@terrablox/ui/card";
import { Textarea } from "@terrablox/ui/textarea";
import { Plus, RotateCcw, X } from "lucide-react";
import { useMemo, useState } from "react";

/**
 * The harness wording, editable without a deploy.
 *
 * What is here and what is not follows one rule: wording is an opinion, structure
 * and claims are not. The sentences the agent is told, the descriptions the
 * screens show — those are iterated on and belong in a form. Which operations
 * exist, their JSON schemas, and the enforcement class beside each element stay in
 * code: a changed schema breaks the agent silently, and an edited enforcement
 * class would only make the harness screen lie about what the code does.
 *
 * Every field is compared against the code default. Only genuinely changed fields
 * are sent, so a field left alone keeps following the source — and a later change
 * to the default still reaches everybody. That is also what makes "put it back" a
 * real button rather than a copy of today's text.
 */
export function HarnessEditor({
  initial,
  defaults,
}: {
  initial: HarnessCurationView;
  defaults: HarnessCurationView;
}) {
  const [rules, setRules] = useState<string[]>(initial.operatingRulesRaw);
  const [texts, setTexts] = useState<Record<string, string>>(() =>
    flatten(initial),
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const defaultTexts = useMemo(() => flatten(defaults), [defaults]);
  const defaultRules = defaults.operatingRulesRaw;

  const rulesChanged =
    rules.length !== defaultRules.length ||
    rules.some((rule, index) => rule !== defaultRules[index]);

  const changedFields = useMemo(
    () => Object.keys(texts).filter((key) => texts[key] !== defaultTexts[key]),
    [texts, defaultTexts],
  );

  const dirty =
    rulesChanged !== initial.operatingRulesOverridden ||
    rules.some((rule, i) => rule !== initial.operatingRulesRaw[i]) ||
    Object.keys(texts).some((key) => texts[key] !== flatten(initial)[key]);

  function set(key: string, value: string) {
    setTexts((current) => ({ ...current, [key]: value }));
    setSaved(false);
  }

  function reset(key: string) {
    set(key, defaultTexts[key] ?? "");
  }

  async function save() {
    setSaving(true);
    setError(null);

    // Only what differs from the code, grouped back into the shape the API
    // validates. A field equal to its default is simply absent, which is how it
    // keeps following the source.
    const overrides: Record<string, unknown> = {};
    if (rulesChanged) overrides.operatingRules = rules;

    for (const key of changedFields) {
      const [group, id, field] = key.split("::");
      if (!group || !id || !field) continue;

      if (!overrides[group]) overrides[group] = {};
      const bucket = overrides[group] as Record<string, Record<string, string>>;

      if (!bucket[id]) bucket[id] = {};
      bucket[id][field] = texts[key] ?? "";
    }

    try {
      const response = await fetch("/api/admin/curation", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(overrides),
      });

      const body = await response.json();
      if (!response.ok) throw new Error(body?.error ?? "Could not save");
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }

  const field = (key: string, label: string, rows = 2): React.ReactNode => {
    const changed = texts[key] !== defaultTexts[key];

    return (
      <div className="space-y-1" key={key}>
        <div className="flex items-center gap-2">
          <span className="font-medium text-xs">{label}</span>
          {changed ? (
            <>
              <Badge className="font-normal" variant="secondary">
                edited
              </Badge>
              <Button
                className="h-6 gap-1 px-1.5 text-xs"
                onClick={() => reset(key)}
                size="sm"
                variant="ghost"
              >
                <RotateCcw className="h-3 w-3" />
                Put back
              </Button>
            </>
          ) : null}
        </div>
        <Textarea
          className="text-xs"
          onChange={(event) => set(key, event.target.value)}
          rows={rows}
          value={texts[key] ?? ""}
        />
      </div>
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Harness wording
          <span className="font-normal text-muted-foreground text-sm">
            editable
          </span>
          {changedFields.length + (rulesChanged ? 1 : 0) > 0 ? (
            <Badge variant="secondary">
              {changedFields.length + (rulesChanged ? 1 : 0)} overridden
            </Badge>
          ) : null}
        </CardTitle>
        <p className="mt-1 text-muted-foreground text-sm">
          Saved to the database and read on every turn, so a change takes effect
          on the next message rather than the next deploy. Anything left at its
          default keeps following the code.
        </p>
      </CardHeader>

      <CardContent className="space-y-6">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <h3 className="font-medium text-xs uppercase tracking-wide">
              Operating rules
            </h3>
            {rulesChanged ? (
              <>
                <Badge className="font-normal" variant="secondary">
                  edited
                </Badge>
                <Button
                  className="h-6 gap-1 px-1.5 text-xs"
                  onClick={() => setRules([...defaultRules])}
                  size="sm"
                  variant="ghost"
                >
                  <RotateCcw className="h-3 w-3" />
                  Put back
                </Button>
              </>
            ) : null}
          </div>
          <p className="text-muted-foreground text-xs">
            The first thing in every prompt, before any project detail. Write{" "}
            <code className="font-mono">{"{maxToolCalls}"}</code> where the
            operation budget belongs — it is substituted from the code, so a
            rule cannot quote a limit that is not enforced.
          </p>

          {/* The index is the identity here: rules are an ordered list a person
              edits in place, and two rules may legitimately hold the same text
              while being reordered. */}
          {rules.map((rule, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity
            <div className="flex items-start gap-2" key={index}>
              <Textarea
                className="text-xs"
                onChange={(event) => {
                  const next = [...rules];
                  next[index] = event.target.value;
                  setRules(next);
                  setSaved(false);
                }}
                rows={2}
                value={rule}
              />
              <Button
                aria-label="Remove this rule"
                className="h-8 w-8 shrink-0"
                onClick={() => setRules(rules.filter((_, i) => i !== index))}
                size="icon"
                variant="ghost"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}

          <Button
            className="gap-1"
            onClick={() => setRules([...rules, ""])}
            size="sm"
            variant="outline"
          >
            <Plus className="h-3.5 w-3.5" />
            Add a rule
          </Button>
        </div>

        <Group title="Operations">
          {initial.operations.map((operation) => (
            <div className="rounded-md border p-3" key={operation.name}>
              <p className="mb-2 font-mono text-xs">{operation.name}</p>
              <div className="space-y-2">
                {field(`operations::${operation.name}::label`, "Label", 1)}
                {field(`operations::${operation.name}::summary`, "Summary")}
                {field(
                  `operations::${operation.name}::description`,
                  "Description sent to the model",
                  3,
                )}
              </div>
            </div>
          ))}
        </Group>

        <Group title="Knowledge sources">
          {initial.knowledge.map((source) => (
            <div className="rounded-md border p-3" key={source.id}>
              <p className="mb-2 font-mono text-xs">{source.id}</p>
              <div className="space-y-2">
                {field(`knowledge::${source.id}::name`, "Name", 1)}
                {field(`knowledge::${source.id}::description`, "Description")}
              </div>
            </div>
          ))}
        </Group>

        <Group title="Harness planes">
          {initial.planes.map((plane) => (
            <div className="rounded-md border p-3" key={plane.id}>
              <p className="mb-2 font-mono text-xs">{plane.label}</p>
              <div className="space-y-2">
                {field(`planes::${plane.id}::summary`, "Summary")}
                {field(`planes::${plane.id}::integration`, "How it integrates")}
              </div>
            </div>
          ))}
        </Group>

        <Group title="Harness elements">
          {initial.elements.map((element) => (
            <div className="rounded-md border p-3" key={element.id}>
              <p className="mb-2 flex flex-wrap items-center gap-2 font-mono text-xs">
                {element.label}
                <Badge className="font-normal" variant="outline">
                  {element.enforcement}
                </Badge>
              </p>
              <div className="space-y-2">
                {field(`elements::${element.id}::brief`, "Diagram text")}
                {field(`elements::${element.id}::description`, "Card text", 3)}
              </div>
            </div>
          ))}
        </Group>

        {error ? <p className="text-destructive text-sm">{error}</p> : null}

        <div className="flex items-center gap-3 border-t pt-4">
          <Button disabled={saving || !dirty} onClick={() => void save()}>
            {saving ? "Saving…" : "Save wording"}
          </Button>
          {saved ? (
            <span className="text-muted-foreground text-xs">
              Saved. The next turn uses it.
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

/** Collapsed by default: five groups of textareas is a lot to scroll past. */
function Group({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="space-y-2">
      <Button
        aria-expanded={open}
        className="h-7 px-1.5 font-medium text-xs uppercase tracking-wide"
        onClick={() => setOpen((value) => !value)}
        size="sm"
        variant="ghost"
      >
        {open ? "▾" : "▸"} {title}
      </Button>
      {open ? <div className="space-y-3">{children}</div> : null}
    </div>
  );
}

/**
 * Every editable text under one flat key, `group::id::field`.
 *
 * A flat map because the form only ever needs "the value at this key" and "the
 * default at this key"; nesting would make every comparison a walk.
 */
function flatten(curation: HarnessCurationView): Record<string, string> {
  const out: Record<string, string> = {};

  for (const operation of curation.operations) {
    out[`operations::${operation.name}::label`] = operation.label;
    out[`operations::${operation.name}::summary`] = operation.summary;
    out[`operations::${operation.name}::description`] = operation.description;
  }
  for (const source of curation.knowledge) {
    out[`knowledge::${source.id}::name`] = source.name;
    out[`knowledge::${source.id}::description`] = source.description;
  }
  for (const plane of curation.planes) {
    out[`planes::${plane.id}::summary`] = plane.summary;
    out[`planes::${plane.id}::integration`] = plane.integration;
  }
  for (const element of curation.elements) {
    out[`elements::${element.id}::brief`] = element.brief;
    out[`elements::${element.id}::description`] = element.description;
  }

  return out;
}

export interface HarnessCurationView {
  operatingRulesRaw: string[];
  operatingRulesOverridden: boolean;
  operations: {
    name: string;
    group: string;
    label: string;
    summary: string;
    description: string;
    overridden: boolean;
  }[];
  knowledge: {
    id: string;
    name: string;
    description: string;
    overridden: boolean;
  }[];
  planes: {
    id: string;
    label: string;
    summary: string;
    integration: string;
    overridden: boolean;
  }[];
  elements: {
    id: string;
    plane: string;
    label: string;
    brief: string;
    description: string;
    enforcement: string;
    source: string;
    overridden: boolean;
  }[];
  updatedAt: string | null;
}
