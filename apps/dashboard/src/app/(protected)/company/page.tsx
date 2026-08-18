"use client";

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
import { SidebarInset, SidebarProvider } from "@terrablox/ui/sidebar";
import { Building2, Check, Loader2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { PageHeader } from "@/components/layout/page-header";
import {
  type CompanySettingsDto,
  normalizeRootFolder,
  normalizeSubmodulesPath,
} from "@/lib/company-settings";

export default function CompanyPage() {
  const [name, setName] = useState("");
  const [submodulesPath, setSubmodulesPath] = useState("");
  const [rootFolder, setRootFolder] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/company-settings");
        const body = (await res.json()) as {
          settings?: CompanySettingsDto;
          error?: string;
        };

        if (cancelled) return;

        if (!res.ok) {
          setError(body.error ?? "Failed to load company settings");
          return;
        }

        setName(body.settings?.name ?? "");
        setSubmodulesPath(body.settings?.terraformSubmodulesPath ?? "");
        setRootFolder(body.settings?.terraformRootFolder ?? "");
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load settings");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);

    try {
      const res = await fetch("/api/company-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          terraformSubmodulesPath: submodulesPath,
          terraformRootFolder: rootFolder,
        }),
      });
      const body = (await res.json()) as {
        settings?: CompanySettingsDto;
        error?: string;
      };

      if (!res.ok) {
        setError(body.error ?? "Failed to save company settings");
        return;
      }

      // Show the stored values so the user sees how their input was normalised.
      setName(body.settings?.name ?? "");
      setSubmodulesPath(body.settings?.terraformSubmodulesPath ?? "");
      setRootFolder(body.settings?.terraformRootFolder ?? "");
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const normalizedSubmodules = normalizeSubmodulesPath(submodulesPath);
  const normalizedRoot = normalizeRootFolder(rootFolder);

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <PageHeader breadcrumbs={[{ label: "Company Settings" }]} />

        <main className="flex-1 p-6">
          <div className="w-full space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Building2 className="h-5 w-5" />
                  Company Settings
                </CardTitle>
                <CardDescription>
                  Repository conventions shared by everything you import. The
                  import wizard applies them automatically, and you can still
                  override them per module.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {loading ? (
                  <div className="flex items-center gap-2 text-muted-foreground text-sm">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading settings…
                  </div>
                ) : (
                  <form onSubmit={handleSubmit} className="space-y-5">
                    <div className="space-y-2">
                      <Label htmlFor="companyName">Company name</Label>
                      <Input
                        id="companyName"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="e.g. Acme GmbH"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="submodulesPath">Submodules path</Label>
                      <Input
                        id="submodulesPath"
                        value={submodulesPath}
                        onChange={(e) => setSubmodulesPath(e.target.value)}
                        placeholder="e.g. modules"
                      />
                      <p className="text-muted-foreground text-xs">
                        Folder that holds one subfolder per submodule. When set,
                        importing a repository pre-selects every subfolder below
                        it that contains Terraform files.
                      </p>
                      {normalizedSubmodules ? (
                        <p className="text-muted-foreground text-xs">
                          Submodules are expected at{" "}
                          <code className="rounded bg-muted px-1 py-0.5 font-mono">
                            {normalizedSubmodules}/&lt;name&gt;
                          </code>
                        </p>
                      ) : null}
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="rootFolder">
                        Terraform root path{" "}
                        <span className="font-normal text-muted-foreground">
                          (optional)
                        </span>
                      </Label>
                      <Input
                        id="rootFolder"
                        value={rootFolder}
                        onChange={(e) => setRootFolder(e.target.value)}
                        placeholder="e.g. ."
                      />
                      <p className="text-muted-foreground text-xs">
                        Where the root module lives inside a repository. Leave
                        empty to keep the default{" "}
                        <code className="rounded bg-muted px-1 py-0.5 font-mono">
                          .
                        </code>
                        {normalizedRoot && normalizedRoot !== "." ? (
                          <>
                            {" "}
                            — currently{" "}
                            <code className="rounded bg-muted px-1 py-0.5 font-mono">
                              {normalizedRoot}
                            </code>
                          </>
                        ) : null}
                      </p>
                    </div>

                    {error ? (
                      <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-destructive text-sm">
                        {error}
                      </div>
                    ) : null}

                    <div className="flex items-center gap-3">
                      <Button type="submit" disabled={saving}>
                        {saving ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Saving…
                          </>
                        ) : (
                          "Save settings"
                        )}
                      </Button>
                      {saved && !saving ? (
                        <span className="flex items-center gap-1 text-muted-foreground text-sm">
                          <Check className="h-4 w-4" />
                          Saved
                        </span>
                      ) : null}
                    </div>
                  </form>
                )}
              </CardContent>
            </Card>
          </div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
