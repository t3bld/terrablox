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
import { Input } from "@terrablox/ui/input";
import { Label } from "@terrablox/ui/label";
import { Loader2, Plug, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { readJson } from "@/lib/read-json";

/**
 * Remote MCP servers the agent may call.
 *
 * Remote only, and that is not a limitation we plan to lift: a local server is
 * a command run on the TerraBlox host, so offering it here would hand every
 * account holder a shell on our infrastructure. The card says so rather than
 * leaving the absence to be read as an oversight.
 */

interface McpServer {
  id: string;
  name: string;
  url: string;
  transport: "http" | "sse";
  enabled: boolean;
  headerNames: string[];
  /** Present instead of the payload when the request failed. */
  error?: string;
}

export function AgentMcpCard() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [headerName, setHeaderName] = useState("Authorization");
  const [headerValue, setHeaderValue] = useState("");
  const [adding, setAdding] = useState(false);

  // Stable identity: every mutation re-reads the list, so this is a dependency
  // of the effect as well as of the handlers, and a fresh function each render
  // would turn that into a request loop.
  const load = useCallback(
    () =>
      fetch("/api/agent/settings")
        .then((res) =>
          readJson<{ mcpServers: McpServer[]; error?: string }>(res),
        )
        .then((data) => {
          if (data.error) {
            setError(data.error);
            return;
          }
          setServers(data.mcpServers);
        })
        .catch(() => setError("Could not load your MCP servers."))
        .finally(() => setLoading(false)),
    [],
  );

  useEffect(() => {
    load();
  }, [load]);

  const add = async () => {
    setAdding(true);
    setError(null);

    try {
      const res = await fetch("/api/agent/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          url,
          transport: "http",
          headers:
            headerName.trim() && headerValue
              ? { [headerName.trim()]: headerValue }
              : {},
        }),
      });

      const data = await readJson<McpServer>(res);

      if (data.error) {
        setError(data.error);
        return;
      }

      setName("");
      setUrl("");
      // The secret is gone from the page as soon as it is stored, which is the
      // only state in which we can promise we are not holding it in the DOM.
      setHeaderValue("");
      await load();
    } catch {
      setError("Could not add that server.");
    } finally {
      setAdding(false);
    }
  };

  const toggle = async (server: McpServer) => {
    setBusyId(server.id);
    setError(null);

    try {
      const res = await fetch(`/api/agent/mcp/${server.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !server.enabled }),
      });

      const data = await readJson<{ ok?: boolean; error?: string }>(res);
      if (data.error) setError(data.error);

      await load();
    } catch {
      setError("Could not change that server.");
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (server: McpServer) => {
    setBusyId(server.id);

    try {
      await fetch(`/api/agent/mcp/${server.id}`, { method: "DELETE" });
      await load();
    } catch {
      setError("Could not remove that server.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Plug className="h-5 w-5" />
          MCP servers
        </CardTitle>
        <CardDescription>
          Give the agent tools from other systems. Remote servers only — a local
          one would run commands on the TerraBlox server itself.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : servers.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No servers yet. The agent works fine without any.
          </p>
        ) : (
          <ul className="grid gap-2">
            {servers.map((server) => (
              <li
                key={server.id}
                className="flex items-center gap-3 rounded-md border p-3"
              >
                <div className="grid min-w-0 flex-1 gap-0.5">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{server.name}</span>
                    <Badge variant={server.enabled ? "success" : "secondary"}>
                      {server.enabled ? "Enabled" : "Off"}
                    </Badge>
                  </div>
                  <span className="truncate text-xs text-muted-foreground">
                    {server.url}
                  </span>
                  {server.headerNames.length ? (
                    <span className="text-xs text-muted-foreground">
                      Sends: {server.headerNames.join(", ")}
                    </span>
                  ) : null}
                </div>

                <Button
                  variant="outline"
                  size="sm"
                  disabled={busyId === server.id}
                  onClick={() => toggle(server)}
                >
                  {busyId === server.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : server.enabled ? (
                    "Disable"
                  ) : (
                    "Enable"
                  )}
                </Button>

                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${server.name}`}
                  disabled={busyId === server.id}
                  onClick={() => remove(server)}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="grid gap-3 border-t pt-4">
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="mcp-name">Name</Label>
              <Input
                id="mcp-name"
                value={name}
                placeholder="jira"
                onChange={(event) => setName(event.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="mcp-url">URL</Label>
              <Input
                id="mcp-url"
                value={url}
                placeholder="https://mcp.example.com/v1"
                onChange={(event) => setUrl(event.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="mcp-header-name">Auth header (optional)</Label>
              <Input
                id="mcp-header-name"
                value={headerName}
                onChange={(event) => setHeaderName(event.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="mcp-header-value">Value</Label>
              <Input
                id="mcp-header-value"
                type="password"
                value={headerValue}
                placeholder="Bearer …"
                onChange={(event) => setHeaderValue(event.target.value)}
              />
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            Stored encrypted and never shown again. New servers start disabled,
            so adding one and trusting it stay separate decisions.
          </p>

          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}

          <div>
            <Button
              variant="outline"
              disabled={adding || !name.trim() || !url.trim()}
              onClick={add}
            >
              {adding ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Plus className="mr-2 h-4 w-4" />
              )}
              Add server
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
