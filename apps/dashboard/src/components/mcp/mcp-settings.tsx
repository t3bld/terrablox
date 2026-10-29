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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@terrablox/ui/dropdown-menu";
import { Input } from "@terrablox/ui/input";
import { Label } from "@terrablox/ui/label";
import { TabsNav, tabPanelProps } from "@terrablox/ui/tabs-nav";
import {
  Check,
  ChevronDown,
  Copy,
  Plus,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

/**
 * Tokens for an editor, and the configuration to paste into one.
 *
 * Both on one screen because they are one task: a token is useless without the config
 * block, and the block is useless without the token. Splitting them would mean copying a
 * secret out of one place into a snippet in another, by hand, which is how secrets end up
 * in the wrong file.
 *
 * The secret is shown exactly once, at creation, and the config blocks appear at that same
 * moment with the token already in them. An example carrying a placeholder is an invitation
 * to come back later for the real value, and by then there is nothing to come back for.
 */

interface TokenSummary {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

type Scope = "read" | "write";

const SCOPES: ReadonlyArray<{ value: Scope; label: string }> = [
  { value: "read", label: "Read only" },
  { value: "write", label: "Read and change" },
];

/** The clients we give a ready-made block for. */
const CLIENTS = [
  { value: "vscode", label: "VS Code" },
  { value: "cli", label: "Copilot CLI" },
  { value: "claude", label: "Claude Desktop" },
] as const;

type ClientId = (typeof CLIENTS)[number]["value"];

function CopyBlock({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-muted-foreground text-xs">
          {label}
        </span>
        <Button
          className="h-7 gap-1.5 px-2 text-xs"
          onClick={() => {
            void navigator.clipboard.writeText(value).then(
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              },
              () => setCopied(false),
            );
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed">
        {value}
      </pre>
    </div>
  );
}

/**
 * The client configurations, one tab each.
 *
 * Tabs rather than three blocks down the page: they are alternatives, not steps, and
 * stacked they read as a list of things to do. Nobody configures all three at once.
 *
 * The differences between them are small and easy to get wrong by eye — VS Code keys the
 * map `servers`, the other two `mcpServers` — so each tab states what it is and where the
 * file lives rather than leaving the reader to diff three near-identical blocks.
 */
function ClientConfigs({ token }: { token: string }) {
  const [client, setClient] = useState<ClientId>("vscode");
  // Read at render rather than at module load: this is a client component, and the origin
  // is whatever host the instance is actually being used on.
  const url = `${window.location.origin}/api/mcp`;

  const server = {
    type: "http" as const,
    url,
    headers: { Authorization: `Bearer ${token}` },
  };

  const vscode = JSON.stringify({ servers: { terrablox: server } }, null, 2);
  const mcpServers = JSON.stringify(
    { mcpServers: { terrablox: server } },
    null,
    2,
  );

  return (
    <div className="space-y-3">
      <TabsNav
        idPrefix="mcp-client"
        label="Client configuration"
        onChange={setClient}
        tabs={CLIENTS.map((entry) => ({
          value: entry.value,
          label: entry.label,
        }))}
        value={client}
      />

      <div {...tabPanelProps("mcp-client", client)}>
        {client === "vscode" ? (
          <div className="space-y-2">
            <CopyBlock label=".vscode/mcp.json" value={vscode} />
            <p className="text-muted-foreground text-xs leading-relaxed">
              Reload the window afterwards, then switch the chat to{" "}
              <strong>Agent</strong> mode — tools are not offered in Ask mode.
              The Agent Host does not read <code>.vscode/mcp.json</code>; for
              configuration that works there too, put the same block in a
              workspace <code>.mcp.json</code>.
            </p>
          </div>
        ) : null}

        {client === "cli" ? (
          <div className="space-y-2">
            <CopyBlock label="~/.copilot/mcp-config.json" value={mcpServers} />
            <p className="text-muted-foreground text-xs leading-relaxed">
              A workspace <code>.mcp.json</code> works as well, and is the
              shareable option. Note the key is <code>mcpServers</code> here,
              not <code>servers</code>.
            </p>
          </div>
        ) : null}

        {client === "claude" ? (
          <div className="space-y-2">
            <CopyBlock
              label="Settings → Developer → Edit Config"
              value={mcpServers}
            />
            <p className="text-muted-foreground text-xs leading-relaxed">
              Claude reaches this endpoint from Anthropic&rsquo;s network rather
              than from your machine, so a <code>localhost</code> URL will not
              work — that needs this instance published at an address they can
              reach. Restart the app after editing.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function McpSettings() {
  const [tokens, setTokens] = useState<TokenSummary[] | null>(null);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<Scope>("read");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Held in memory only, and only until the page is left. */
  const [fresh, setFresh] = useState<{ token: string; name: string } | null>(
    null,
  );

  const load = useCallback(async () => {
    const response = await fetch("/api/account/tokens");
    if (!response.ok) {
      setTokens([]);
      return;
    }
    const body = (await response.json()) as { tokens: TokenSummary[] };
    setTokens(body.tokens);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setCreating(true);
    setError(null);

    try {
      const response = await fetch("/api/account/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, scopes: [scope] }),
      });

      const body = (await response.json()) as {
        token?: string;
        error?: string;
      };

      if (!response.ok || !body.token) {
        setError(body.error ?? "The token could not be created.");
        return;
      }

      setFresh({ token: body.token, name });
      setName("");
      await load();
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string) {
    await fetch(`/api/account/tokens/${id}`, { method: "DELETE" });
    // Clears the panel when the token on screen is the one being revoked, so a copy
    // block cannot outlive the credential inside it.
    setFresh(null);
    await load();
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Generate Tokens</CardTitle>
        </CardHeader>

        <CardContent className="space-y-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="grid flex-1 gap-1.5">
              <Label htmlFor="token-name">Name</Label>
              <Input
                id="token-name"
                onChange={(event) => setName(event.target.value)}
                placeholder="VS Code on the laptop"
                value={name}
              />
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="token-scope">Access</Label>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    className="w-[190px] justify-between"
                    id="token-scope"
                    type="button"
                    variant="outline"
                  >
                    {SCOPES.find((entry) => entry.value === scope)?.label}
                    <ChevronDown className="h-4 w-4 opacity-60" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-[190px]">
                  {SCOPES.map((entry) => (
                    <DropdownMenuItem
                      className="gap-2"
                      key={entry.value}
                      onSelect={() => setScope(entry.value)}
                    >
                      {entry.value === scope ? (
                        <Check className="h-3.5 w-3.5" />
                      ) : (
                        <span className="w-3.5" />
                      )}
                      {entry.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <Button
              className="gap-1.5"
              disabled={creating || name.trim().length === 0}
              onClick={() => void create()}
              type="button"
            >
              <Plus className="h-4 w-4" />
              Create token
            </Button>
          </div>

          {scope === "write" ? (
            <p className="flex items-start gap-2 text-muted-foreground text-xs leading-relaxed">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
              {/* Said before the token exists, not after: the decision being warned
                  about is the one about to be made. */}
              A token with write access can commit Terraform to your
              repositories and start deployments into your AWS account. It will
              sit in a plain-text config file on the machine you paste it into.
            </p>
          ) : null}

          {error ? <p className="text-destructive text-sm">{error}</p> : null}

          {fresh ? (
            <div className="space-y-4 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
              <div>
                <p className="font-medium text-sm">
                  Copy this now — it is not shown again
                </p>
                <p className="mt-1 text-muted-foreground text-xs">
                  “{fresh.name}” is stored only as a hash, so this is the one
                  and only time the secret exists anywhere but in your
                  clipboard.
                </p>
              </div>

              <CopyBlock label="Token" value={fresh.token} />
              <ClientConfigs token={fresh.token} />

              <Button
                onClick={() => setFresh(null)}
                size="sm"
                type="button"
                variant="outline"
              >
                I have copied it
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Tokens</CardTitle>
          <CardDescription>
            Revoking one takes effect immediately, on the next request that uses
            it.
          </CardDescription>
        </CardHeader>

        <CardContent>
          {tokens === null ? (
            <p className="text-muted-foreground text-sm">Loading…</p>
          ) : tokens.length === 0 ? (
            <p className="rounded-lg border border-dashed px-4 py-6 text-center text-muted-foreground text-sm">
              No tokens yet. Nothing outside this browser can reach your
              projects.
            </p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {tokens.map((token) => (
                <li
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3"
                  key={token.id}
                >
                  <span className="font-medium text-sm">{token.name}</span>
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-muted-foreground text-xs">
                    {token.tokenPrefix}…
                  </code>
                  <Badge
                    variant={
                      token.scopes.includes("write") ? "default" : "secondary"
                    }
                  >
                    {token.scopes.includes("write")
                      ? "read + change"
                      : "read only"}
                  </Badge>

                  <span className="text-muted-foreground text-xs">
                    {token.lastUsedAt
                      ? `last used ${new Date(token.lastUsedAt).toLocaleString()}`
                      : "never used"}
                    {token.expiresAt
                      ? ` · expires ${new Date(token.expiresAt).toLocaleDateString()}`
                      : ""}
                  </span>

                  <Button
                    aria-label={`Revoke ${token.name}`}
                    className="ml-auto h-8 gap-1.5 text-xs"
                    onClick={() => void revoke(token.id)}
                    size="sm"
                    variant="ghost"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
