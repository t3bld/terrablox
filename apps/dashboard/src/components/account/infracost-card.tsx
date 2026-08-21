"use client";

import { Badge } from "@terrablox/ui/badge";
import { Button } from "@terrablox/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@terrablox/ui/card";
import { Input } from "@terrablox/ui/input";
import { Label } from "@terrablox/ui/label";
import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";

import { readJson } from "@/lib/read-json";

interface Status {
  configured: boolean;
  hint: string | null;
  updatedAt: string | null;
  problem: string | null;
  error?: string;
}

/**
 * Your own Infracost key, not a shared one.
 *
 * The key never leaves the server once saved, so the field is always empty on
 * load: there is nothing to prefill with, and showing a masked placeholder
 * would suggest the value could be recovered here.
 */
export function InfracostCard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/integrations/infracost")
      .then((res) => readJson<Status>(res))
      .then((data) => {
        if (data.error) {
          setError(data.error);
          return;
        }
        setStatus(data);
      })
      .catch(() => setError("Could not load your Infracost settings."));
  }, []);

  const save = async () => {
    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/integrations/infracost", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });

      const data = await readJson<Status>(res);

      if (data.error) {
        setError(data.error);
        return;
      }

      setStatus(data);
      setApiKey("");
    } catch {
      setError("Could not save the key.");
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/integrations/infracost", {
        method: "DELETE",
      });

      const data = await readJson<Status>(res);

      if (data.error) {
        setError(data.error);
        return;
      }

      setStatus(data);
    } catch {
      setError("Could not remove the key.");
    } finally {
      setBusy(false);
    }
  };

  return (
    // Same shape as the GitHub card: full height, column content, action pinned
    // to the bottom edge so the two cards in this row agree with each other.
    <Card className="flex h-full flex-col">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <CardTitle>Infracost</CardTitle>
              <Button asChild className="h-7 w-7" size="icon" variant="ghost">
                <a
                  aria-label="Open Infracost website"
                  href="https://www.infracost.io"
                  rel="noreferrer"
                  target="_blank"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </Button>
            </div>
          </div>
          <Badge
            className={
              status?.configured
                ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950 dark:text-emerald-300 dark:hover:bg-emerald-950"
                : "text-muted-foreground"
            }
            variant={status?.configured ? "secondary" : "outline"}
          >
            {status?.configured ? "Connected" : "Unconnected"}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col space-y-3">
        {status?.configured ? (
          <Button
            className="mt-auto w-full"
            disabled={busy}
            onClick={() => void disconnect()}
            variant="outline"
          >
            Remove
          </Button>
        ) : (
          <>
            <div className="space-y-2">
              <Label htmlFor="infracost-api-key">CLI token v2</Label>
              <Input
                autoComplete="off"
                id="infracost-api-key"
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="ics_v1_example0123456789abcdef0123456789"
                type="password"
                value={apiKey}
              />
            </div>

            {status?.problem ? (
              <p className="text-sm text-destructive">{status.problem}</p>
            ) : null}
            {error ? <p className="text-sm text-destructive">{error}</p> : null}

            <Button
              className="mt-auto w-full cursor-pointer disabled:cursor-not-allowed"
              disabled={busy || !apiKey.trim()}
              onClick={() => void save()}
            >
              Save key
            </Button>
          </>
        )}

        {error && status?.configured ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
