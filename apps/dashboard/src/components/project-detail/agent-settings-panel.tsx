"use client";

import { Button } from "@terrablox/ui/button";
import { Skeleton } from "@terrablox/ui/skeleton";
import { ToggleRow } from "@terrablox/ui/toggle-row";
import { AlertCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

interface Overrides {
  skills?: string[];
  disabledTools?: string[];
}

interface Payload {
  overrides: Overrides;
  effective: {
    skills: string[];
    disabledTools: string[];
  };
  global: {
    skills: string[];
    disabledTools: string[];
  };
  catalogue: {
    skills: Array<{ id: string; name: string; description: string }>;
    tools: Array<{ name: string; label: string; summary: string }>;
  };
}

/**
 * Agent settings for one project, layered over the global ones.
 *
 * Every field starts inherited and stays that way until the user takes it over,
 * so a change to the global settings still reaches projects nobody has tuned.
 * Taking a field over is explicit rather than implied by editing, otherwise a
 * stray click would silently cut a project off from the defaults.
 *
 * Rendered inside the agent panel's settings dialog, which supplies the title.
 */
export function AgentSettingsPanel({ projectId }: { projectId: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch(`/api/projects/${projectId}/agent-settings`);
    const body = await response.json();
    if (!response.ok) throw new Error(body?.error ?? "Failed to load");
    return body as Payload;
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;

    load()
      .then((next) => {
        if (!cancelled) setData(next);
      })
      .catch(() => {
        if (!cancelled)
          setError("Could not load this project's agent settings.");
      });

    return () => {
      cancelled = true;
    };
  }, [load]);

  async function save(next: Overrides) {
    setSaving(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/projects/${projectId}/agent-settings`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(next),
        },
      );

      const body = await response.json();
      if (!response.ok) throw new Error(body?.error ?? "Could not save that.");
      setData(await load());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save that.");
    } finally {
      setSaving(false);
    }
  }

  if (error && !data) {
    return (
      <p className="flex items-center gap-2 p-1 text-sm text-destructive">
        <AlertCircle className="h-4 w-4 shrink-0" />
        {error}
      </p>
    );
  }

  if (!data) return <Skeleton className="h-64" />;

  const { catalogue, effective, global, overrides } = data;
  const owns = (field: keyof Overrides) => overrides[field] !== undefined;

  /** Takes a field over at its current effective value, or hands it back. */
  function setOwnership(field: keyof Overrides, own: boolean) {
    const next: Overrides = { ...overrides };

    if (!own) {
      delete next[field];
    } else if (field === "skills") {
      next.skills = effective.skills;
    } else {
      next.disabledTools = effective.disabledTools;
    }

    void save(next);
  }

  function toggleInList(field: "skills" | "disabledTools", id: string) {
    const current = overrides[field] ?? effective[field];
    const next = current.includes(id)
      ? current.filter((entry) => entry !== id)
      : [...current, id];

    void save({ ...overrides, [field]: next });
  }

  return (
    <div className="space-y-8 pb-1">
      {error ? (
        <p className="flex items-center gap-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </p>
      ) : null}

      <Section
        inheritedLabel={`${global.skills.length} on`}
        onOwnership={(own) => setOwnership("skills", own)}
        owned={owns("skills")}
        saving={saving}
        title="Knowledge"
      >
        <div className="grid gap-2 md:grid-cols-2">
          {catalogue.skills.map((skill) => (
            <ToggleRow
              description={skill.description}
              disabled={saving}
              key={skill.id}
              label={skill.name}
              on={effective.skills.includes(skill.id)}
              onToggle={() => toggleInList("skills", skill.id)}
            />
          ))}
        </div>
      </Section>

      <Section
        inheritedLabel={`${
          catalogue.tools.length - global.disabledTools.length
        } of ${catalogue.tools.length} allowed`}
        onOwnership={(own) => setOwnership("disabledTools", own)}
        owned={owns("disabledTools")}
        saving={saving}
        title="What the agent may change"
      >
        <div className="grid gap-2 md:grid-cols-2">
          {catalogue.tools.map((tool) => (
            <ToggleRow
              description={tool.summary}
              disabled={saving}
              key={tool.name}
              label={tool.label}
              on={!effective.disabledTools.includes(tool.name)}
              onToggle={() => toggleInList("disabledTools", tool.name)}
            />
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          A tool that is off is never handed to the agent, so it tells you it is
          disabled instead of failing mid-turn.
        </p>
      </Section>
    </div>
  );
}

function Section({
  children,
  inheritedLabel,
  onOwnership,
  owned,
  saving,
  title,
}: {
  children: React.ReactNode;
  inheritedLabel: string;
  onOwnership: (own: boolean) => void;
  owned: boolean;
  saving: boolean;
  title: string;
}) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {owned ? "Set for this project" : `Inherited — ${inheritedLabel}`}
          </span>
          <Button
            disabled={saving}
            onClick={() => onOwnership(!owned)}
            size="sm"
            variant="outline"
          >
            {owned ? "Use global" : "Override"}
          </Button>
        </div>
      </div>

      <div
        className={
          owned ? "space-y-2" : "pointer-events-none space-y-2 opacity-50"
        }
      >
        {children}
      </div>
    </section>
  );
}
