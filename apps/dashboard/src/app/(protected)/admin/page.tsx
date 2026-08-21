"use client";

import { Badge } from "@terrablox/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@terrablox/ui/card";
import { Input } from "@terrablox/ui/input";
import { SidebarInset, SidebarProvider } from "@terrablox/ui/sidebar";
import { Skeleton } from "@terrablox/ui/skeleton";
import { AlertTriangle, ChevronDown, Search } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";

import {
  type HarnessCurationView,
  HarnessEditor,
} from "@/components/admin/harness-editor";
import { AppSidebar } from "@/components/app-sidebar";
import { PageHeader } from "@/components/layout/page-header";

/**
 * What TerraBlox knows because somebody wrote it down.
 *
 * Reachable at `/admin` and linked from nowhere, which is how it should be — but
 * unlinked is not private, and the banner at the top says so. Every signed-in user
 * can type the URL. That is acceptable only because there is nothing here but
 * classification tables that also ship in the source; the moment this page grows a
 * write button or shows another tenant's data, it needs a real gate.
 *
 * The coverage figures are the reason it exists. A curated table looks complete in
 * the source and is only ever as good as its overlap with what people import, and
 * that overlap cannot be seen from the file.
 */
export default function AdminPage() {
  const [data, setData] = useState<CurationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/admin/curation")
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? "Failed to load");
        return body as CurationResponse;
      })
      .then((body) => {
        if (!cancelled) setData(body);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load");
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <PageHeader breadcrumbs={[{ label: "Curation" }]} />

        <main className="flex-1 space-y-6 p-6">
          <div
            className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-xs"
            role="note"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <p>
              <span className="font-medium">
                Not linked anywhere, and not access-controlled either.
              </span>{" "}
              Any signed-in user who knows the URL can read this page. It holds
              no secrets and no other user's data — only the classification
              tables that also ship in the source — but do not add anything here
              that would not survive that.
            </p>
          </div>

          {error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : !data ? (
            <>
              <Skeleton className="h-28 w-full" />
              <Skeleton className="h-64 w-full" />
            </>
          ) : (
            <AdminContent data={data} />
          )}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}

function AdminContent({ data }: { data: CurationResponse }) {
  const { catalogue, cost, architecture, services, agent, conventions } = data;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Coverage</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <Figure
            label="Resource types imported here"
            note={`across ${catalogue.uses.toLocaleString("en")} blocks`}
            value={catalogue.types}
          />
          <Figure
            label="With a cost class"
            note={`${cost.coverage.unclassified.length} unclassified · ${cost.coverage.usesUnclassified} blocks`}
            value={`${cost.coverage.classified} / ${catalogue.types}`}
            percent={cost.coverage.classified / catalogue.types}
          />
          <Figure
            label="On the architecture diagram"
            note={`${architecture.coverage.unclassified.length} unclassified · ${architecture.coverage.usesUnclassified} blocks`}
            value={`${architecture.coverage.classified} / ${catalogue.types}`}
            percent={architecture.coverage.classified / catalogue.types}
          />
        </CardContent>
      </Card>

      {/* The actionable half: what is imported and still has no answer, most used
          first. Everything below this is reference. */}
      <HarnessEditor defaults={data.harnessDefaults} initial={data.harness} />

      <Section
        count={cost.coverage.unclassified.length}
        subtitle="Imported here, no cost class. Most used first — these are what a curation pass should work through."
        title="Unclassified: cost"
      >
        <UsesTable rows={cost.coverage.unclassified} />
      </Section>

      <Section
        count={architecture.coverage.unclassified.length}
        subtitle="Imported here, no entry in the architecture table, so left off the diagram rather than drawn."
        title="Unclassified: architecture"
      >
        <UsesTable rows={architecture.coverage.unclassified} />
      </Section>

      <Section
        count={cost.curated.length}
        subtitle="Hand-written, one entry per resource type. The class, what it bills on, and the input names that size it."
        title="Cost drivers"
      >
        <Searchable
          keyOf={(row) => `${row.type} ${row.costClass} ${row.driver ?? ""}`}
          rows={cost.curated}
        >
          {(rows) => (
            <table className="w-full text-xs">
              <tbody>
                {rows.map((row) => (
                  <tr className="border-b align-top" key={row.type}>
                    <td className="w-72 py-1.5 pr-3 font-mono">{row.type}</td>
                    <td className="w-40 py-1.5 pr-3">
                      <Badge
                        variant={
                          row.costClass === "free" ? "outline" : "secondary"
                        }
                      >
                        {row.costClass}
                      </Badge>
                    </td>
                    <td className="py-1.5 text-muted-foreground">
                      {row.driver ?? <span className="opacity-60">—</span>}
                      {row.sizedBy.length > 0 ? (
                        <span className="mt-0.5 block font-mono opacity-70">
                          sized by: {row.sizedBy.join(", ")}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Searchable>
      </Section>

      <Section
        count={cost.freeList.length}
        subtitle="Types taken as carrying no charge of their own, from the classification Infracost maintains. No prose, because there is nothing to explain."
        title="Cost: known-free list"
      >
        <Chips items={cost.freeList} />
      </Section>

      <Section
        count={cost.suffixRule.length}
        subtitle="Name endings treated as a setting on another resource. Applied only after the two lists above miss. `_configuration`, `_key` and `_cache` are deliberately absent — they bill."
        title="Cost: structural rule"
      >
        <Chips items={cost.suffixRule} />
      </Section>

      <Section
        count={architecture.curated.length}
        subtitle="What each resource type is on a diagram: a service box, a frame that contains others, or detail nobody draws."
        title="Architecture map"
      >
        <Searchable
          keyOf={(row) => `${row.type} ${row.role} ${row.label ?? ""}`}
          rows={architecture.curated}
        >
          {(rows) => (
            <table className="w-full text-xs">
              <tbody>
                {rows.map((row) => (
                  <tr className="border-b align-top" key={row.type}>
                    <td className="w-72 py-1.5 pr-3 font-mono">{row.type}</td>
                    <td className="w-28 py-1.5 pr-3">
                      <Badge
                        variant={row.role === "omit" ? "outline" : "secondary"}
                      >
                        {row.role}
                      </Badge>
                    </td>
                    <td className="py-1.5 pr-3">{row.label ?? "—"}</td>
                    <td className="w-48 py-1.5 font-mono text-muted-foreground">
                      {row.icon ?? "—"}
                      {row.group ? ` · ${row.group}` : ""}
                      {row.global ? " · global" : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Searchable>
      </Section>

      <Section
        count={Object.keys(architecture.containment).length}
        subtitle="Attributes that mean “lives inside”. Terraform has no other way to say it, so this list is what turns a reference into a frame."
        title="Containment attributes"
      >
        <KeyValues record={architecture.containment} />
      </Section>

      <Section
        count={
          Object.keys(services.byType).length +
          Object.keys(services.byPrefix).length
        }
        subtitle={`Resource type or prefix to service name, and service to icon. ${services.iconsVendored} AWS icons are vendored.`}
        title="Service and icon mapping"
      >
        <div className="space-y-4">
          <Labelled title="By exact type">
            <KeyValues record={services.byType} />
          </Labelled>
          <Labelled title="By type prefix">
            <KeyValues record={services.byPrefix} />
          </Labelled>
          <Labelled title="Service to icon">
            <KeyValues record={services.iconByService} />
          </Labelled>
        </div>
      </Section>

      <Section
        count={agent.planes.length}
        subtitle="Read-only, because these are claims about what the code does rather than wording: which plane an element sits on, how it is enforced, and where to check it."
        title="Harness structure"
      >
        <div className="space-y-4 text-xs">
          <Labelled title="Harness, by plane">
            <div className="space-y-2">
              {agent.planes.map((plane) => (
                <div key={plane.id}>
                  <p className="font-medium">{plane.label}</p>
                  <ul className="mt-0.5 space-y-0.5">
                    {plane.elements.map((element) => (
                      <li
                        className="flex flex-wrap items-baseline gap-x-2"
                        key={element.label}
                      >
                        <span>{element.label}</span>
                        <Badge className="font-normal" variant="outline">
                          {element.enforcement}
                        </Badge>
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {element.source}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </Labelled>

          <Labelled title="Limits">
            <KeyValues
              record={Object.fromEntries(
                Object.entries(agent.limits).map(([key, value]) => [
                  key,
                  String(value),
                ]),
              )}
            />
          </Labelled>

          <Labelled title="Fallback models">
            <Chips items={agent.fallbackModels} />
          </Labelled>
        </div>
      </Section>

      <Section
        count={conventions.conventionalLabels.length}
        subtitle="Block labels treated as saying nothing, and the folder a repository is expected to keep submodules in."
        title="Conventions"
      >
        <div className="space-y-3">
          <Labelled title="Labels hidden as conventional">
            <Chips items={conventions.conventionalLabels} />
          </Labelled>
          <Labelled title="Submodule folder">
            <Chips items={[conventions.submodulesFolder]} />
          </Labelled>
        </div>
      </Section>
    </>
  );
}

function Figure({
  label,
  value,
  note,
  percent,
}: {
  label: string;
  value: string | number;
  note?: string;
  percent?: number;
}) {
  return (
    <div>
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="mt-0.5 font-semibold text-2xl tabular-nums">
        {value}
        {percent !== undefined ? (
          <span className="ml-2 font-normal text-muted-foreground text-sm">
            {Math.round(percent * 100)}%
          </span>
        ) : null}
      </p>
      {note ? (
        <p className="mt-0.5 text-[11px] text-muted-foreground">{note}</p>
      ) : null}
    </div>
  );
}

/** Collapsed by default: the page is an inventory, not a reading task. */
function Section({
  title,
  subtitle,
  count,
  children,
}: {
  title: string;
  subtitle: string;
  count: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Card>
      <CardHeader>
        <button
          aria-expanded={open}
          className="flex w-full items-start gap-2 text-left"
          onClick={() => setOpen((value) => !value)}
          type="button"
        >
          <ChevronDown
            className={`mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
              open ? "" : "-rotate-90"
            }`}
          />
          <div className="min-w-0 flex-1">
            <CardTitle className="flex items-center gap-2">
              {title}
              <span className="font-normal text-muted-foreground text-sm tabular-nums">
                {count}
              </span>
            </CardTitle>
            <p className="mt-1 text-muted-foreground text-sm">{subtitle}</p>
          </div>
        </button>
      </CardHeader>
      {open ? <CardContent>{children}</CardContent> : null}
    </Card>
  );
}

/** A filter over rows, shown once the list is past skimming length. */
function Searchable<T>({
  rows,
  keyOf,
  children,
}: {
  rows: T[];
  keyOf: (row: T) => string;
  children: (rows: T[]) => ReactNode;
}) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) => keyOf(row).toLowerCase().includes(needle));
  }, [rows, query, keyOf]);

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-9"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter"
          value={query}
        />
      </div>
      <div className="max-h-[32rem] overflow-y-auto">{children(filtered)}</div>
      {filtered.length !== rows.length ? (
        <p className="text-muted-foreground text-xs">
          {filtered.length} of {rows.length}
        </p>
      ) : null}
    </div>
  );
}

function UsesTable({ rows }: { rows: { type: string; uses: number }[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        Nothing — every type imported here has an answer.
      </p>
    );
  }

  return (
    <Searchable keyOf={(row) => row.type} rows={rows}>
      {(filtered) => (
        <table className="w-full text-xs">
          <tbody>
            {filtered.map((row) => (
              <tr className="border-b" key={row.type}>
                <td className="py-1.5 font-mono">{row.type}</td>
                <td className="w-24 py-1.5 text-right tabular-nums text-muted-foreground">
                  {row.uses}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Searchable>
  );
}

function KeyValues({ record }: { record: Record<string, string> }) {
  const entries = Object.entries(record).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="max-h-80 overflow-y-auto">
      <table className="w-full text-xs">
        <tbody>
          {entries.map(([key, value]) => (
            <tr className="border-b" key={key}>
              <td className="w-72 py-1 pr-3 font-mono">{key}</td>
              <td className="py-1 text-muted-foreground">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Chips({ items }: { items: readonly string[] }) {
  return (
    <div className="flex max-h-64 flex-wrap gap-1 overflow-y-auto">
      {items.map((item) => (
        <code
          className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
          key={item}
        >
          {item}
        </code>
      ))}
    </div>
  );
}

function Labelled({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {title}
      </p>
      {children}
    </div>
  );
}

interface CurationResponse {
  catalogue: { types: number; uses: number };
  cost: {
    curated: {
      type: string;
      costClass: string;
      driver: string | null;
      sizedBy: readonly string[];
    }[];
    freeList: string[];
    suffixRule: readonly string[];
    coverage: {
      classified: number;
      unclassified: { type: string; uses: number }[];
      usesUnclassified: number;
    };
  };
  architecture: {
    curated: {
      type: string;
      role: string;
      label: string | null;
      icon: string | null;
      group: string | null;
      global: boolean;
    }[];
    containment: Record<string, string>;
    coverage: {
      classified: number;
      unclassified: { type: string; uses: number }[];
      usesUnclassified: number;
    };
  };
  services: {
    byType: Record<string, string>;
    byPrefix: Record<string, string>;
    iconByService: Record<string, string>;
    iconsVendored: number;
  };
  harness: HarnessCurationView;
  harnessDefaults: HarnessCurationView;
  agent: {
    knowledge: { id: string; name: string; description: string }[];
    planes: {
      id: string;
      label: string;
      elements: {
        label: string;
        enforcement: string;
        setting: string | null;
        source: string;
      }[];
    }[];
    fallbackModels: string[];
    limits: Record<string, number>;
  };
  conventions: { conventionalLabels: string[]; submodulesFolder: string };
}
