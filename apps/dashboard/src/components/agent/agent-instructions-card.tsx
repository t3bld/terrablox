"use client";

import { Badge } from "@terrablox/ui/badge";
import { Button } from "@terrablox/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@terrablox/ui/card";
import { Label } from "@terrablox/ui/label";
import { Textarea } from "@terrablox/ui/textarea";
import { Check, Loader2, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

import { readJson } from "@/lib/read-json";

/**
 * What the agent is told before it sees a project.
 *
 * Instructions and skills sit in one card because they are the same mechanism
 * seen from two angles: both end up in the system prompt, and both are saved by
 * the same button. Splitting them would suggest they behave differently.
 */

interface Skill {
  id: string;
  name: string;
  description: string;
}

interface Settings {
  instructions: string;
  skills: string[];
  catalogue: Skill[];
  /** Present instead of the payload when the request failed. */
  error?: string;
}

const MAX_LENGTH = 4000;

export function AgentInstructionsCard() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [instructions, setInstructions] = useState("");
  const [skills, setSkills] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/agent/settings")
      .then((res) => readJson<Settings>(res))
      .then((data) => {
        if (data.error) {
          setError(data.error);
          return;
        }

        setSettings(data);
        setInstructions(data.instructions);
        setSkills(data.skills);
      })
      .catch(() => setError("Could not load your agent settings."));
  }, []);

  const toggleSkill = (id: string) => {
    setSaved(false);
    setSkills((current) =>
      current.includes(id)
        ? current.filter((entry) => entry !== id)
        : [...current, id],
    );
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);

    try {
      const res = await fetch("/api/agent/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instructions, skills }),
      });

      const data = await readJson<Settings>(res);

      if (data.error) {
        setError(data.error);
        return;
      }

      setSettings(data);
      setSaved(true);
    } catch {
      setError("Could not save your agent settings.");
    } finally {
      setSaving(false);
    }
  };

  const overLimit = instructions.length > MAX_LENGTH;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-5 w-5" />
          Instructions and skills
        </CardTitle>
        <CardDescription>
          Added to the agent's system prompt on every turn, so it applies to all
          of your projects.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor="agent-instructions">Your own instructions</Label>
          <Textarea
            id="agent-instructions"
            rows={6}
            value={instructions}
            placeholder="e.g. Always name modules after the service they run, never after the AWS resource."
            onChange={(event) => {
              setInstructions(event.target.value);
              setSaved(false);
            }}
          />
          <p
            className={`text-xs ${overLimit ? "text-destructive" : "text-muted-foreground"}`}
          >
            {instructions.length} of {MAX_LENGTH} characters
          </p>
        </div>

        <div className="space-y-2">
          <Label>Skills</Label>
          <p className="text-sm text-muted-foreground">
            Ready-made rules we maintain. Enabled skills are added to the prompt
            in full.
          </p>

          <div className="grid gap-2 pt-1">
            {settings?.catalogue.map((skill) => {
              const on = skills.includes(skill.id);

              return (
                <button
                  key={skill.id}
                  type="button"
                  onClick={() => toggleSkill(skill.id)}
                  aria-pressed={on}
                  className={`flex items-start gap-3 rounded-md border p-3 text-left transition-colors hover:bg-accent ${
                    on ? "border-primary bg-accent/50" : "border-border"
                  }`}
                >
                  <span
                    className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border ${
                      on
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-input"
                    }`}
                  >
                    {on ? <Check className="size-3" /> : null}
                  </span>

                  <span className="grid gap-0.5">
                    <span className="text-sm font-medium">{skill.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {skill.description}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex items-center gap-3">
          <Button onClick={save} disabled={saving || overLimit || !settings}>
            {saving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Check className="mr-2 h-4 w-4" />
            )}
            Save
          </Button>

          {saved ? <Badge variant="success">Saved</Badge> : null}
        </div>
      </CardContent>
    </Card>
  );
}
