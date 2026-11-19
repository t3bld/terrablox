"use client";

import { Badge } from "@terrablox/ui/badge";
import { Button } from "@terrablox/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@terrablox/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@terrablox/ui/dialog";
import { Input } from "@terrablox/ui/input";
import { Label } from "@terrablox/ui/label";
import { Select } from "@terrablox/ui/select";
import { Skeleton } from "@terrablox/ui/skeleton";
import {
  Archive,
  Library,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

type LibraryScope = "global" | "user";

interface AdminModuleLibrary {
  id: string;
  name: string;
  scope: LibraryScope;
  visible: boolean;
  active: boolean;
  org: string;
  topics: string[];
  prefix: string | null;
  publicOnly: boolean;
  submoduleContainer: string | null;
  pipelineSecret: string;
  sortOrder: number;
  counts: {
    sources: number;
    modules: number;
    users: number;
  };
}

interface LibraryFormState {
  id: string;
  name: string;
  scope: LibraryScope;
  org: string;
  topics: string;
  prefix: string;
  submoduleContainer: string;
  pipelineSecret: string;
  publicOnly: boolean;
  visible: boolean;
}

const EMPTY_FORM: LibraryFormState = {
  id: "",
  name: "",
  scope: "global",
  org: "",
  topics: "",
  prefix: "",
  submoduleContainer: "",
  pipelineSecret: "",
  publicOnly: true,
  visible: true,
};

function errorMessage(body: unknown, fallback: string): string {
  if (
    body &&
    typeof body === "object" &&
    "error" in body &&
    typeof body.error === "string" &&
    body.error
  ) {
    return body.error;
  }
  return fallback;
}

function sorted(libraries: AdminModuleLibrary[]): AdminModuleLibrary[] {
  return [...libraries].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
  );
}

export function ModuleLibrariesPanel() {
  const [libraries, setLibraries] = useState<AdminModuleLibrary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [editing, setEditing] = useState<AdminModuleLibrary | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [changingStatus, setChangingStatus] =
    useState<AdminModuleLibrary | null>(null);

  const loadLibraries = useCallback(async () => {
    setLoading(true);
    setError(null);
    setForbidden(false);

    try {
      const response = await fetch("/api/admin/module-libraries", {
        cache: "no-store",
      });
      const body = await response.json().catch(() => ({}));

      if (response.status === 403) {
        setForbidden(true);
        return;
      }
      if (!response.ok) {
        throw new Error(errorMessage(body, "Failed to load module libraries"));
      }

      setLibraries(sorted((body.libraries ?? []) as AdminModuleLibrary[]));
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load module libraries",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadLibraries();
  }, [loadLibraries]);

  const totals = useMemo(
    () =>
      libraries.reduce(
        (sum, library) => ({
          sources: sum.sources + library.counts.sources,
          modules: sum.modules + library.counts.modules,
          users: sum.users + library.counts.users,
        }),
        { sources: 0, modules: 0, users: 0 },
      ),
    [libraries],
  );

  const replaceLibrary = (library: AdminModuleLibrary) => {
    setLibraries((current) =>
      sorted([
        ...current.filter((candidate) => candidate.id !== library.id),
        library,
      ]),
    );
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full" />
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  if (forbidden) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Administrator access required</CardTitle>
          <CardDescription>
            Your account does not currently have permission to manage module
            libraries. Accounts are admins by default; an instance operator can
            restore access with:
            <code className="mt-2 block font-mono text-xs">
              pnpm db:user:promote --email you@example.com
            </code>
            Other admin tabs remain available above.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Module libraries could not be loaded</CardTitle>
          <CardDescription className="text-destructive" role="alert">
            {error}
          </CardDescription>
        </CardHeader>
        <CardFooter>
          <Button
            onClick={() => void loadLibraries()}
            type="button"
            variant="outline"
          >
            Try again
          </Button>
        </CardFooter>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2">
              <Library aria-hidden="true" className="h-5 w-5" />
              Module Libraries
            </CardTitle>
            <CardDescription>
              Configure catalogue sources. Archiving hides a library without
              deleting its configuration or imported data.
            </CardDescription>
          </div>
          <Button
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
            type="button"
          >
            <Plus aria-hidden="true" className="mr-2 h-4 w-4" />
            Add library
          </Button>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Summary label="Libraries" value={libraries.length} />
          <Summary label="Sources" value={totals.sources} />
          <Summary label="Modules" value={totals.modules} />
          <Summary label="Users" value={totals.users} />
        </CardContent>
      </Card>

      {libraries.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground text-sm">
            No module libraries configured.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {libraries.map((library) => (
            <LibraryCard
              key={library.id}
              library={library}
              onEdit={() => {
                setEditing(library);
                setFormOpen(true);
              }}
              onStatusChange={() => setChangingStatus(library)}
            />
          ))}
        </div>
      )}

      <LibraryFormDialog
        library={editing}
        onOpenChange={setFormOpen}
        onSaved={replaceLibrary}
        open={formOpen}
      />
      <LibraryStatusDialog
        library={changingStatus}
        onChanged={replaceLibrary}
        onOpenChange={(open) => {
          if (!open) setChangingStatus(null);
        }}
      />
    </div>
  );
}

function Summary({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border p-3">
      <div className="font-semibold text-2xl tabular-nums">{value}</div>
      <div className="text-muted-foreground text-xs">{label}</div>
    </div>
  );
}

function LibraryCard({
  library,
  onEdit,
  onStatusChange,
}: {
  library: AdminModuleLibrary;
  onEdit: () => void;
  onStatusChange: () => void;
}) {
  return (
    <Card className={!library.active ? "opacity-75" : undefined}>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="truncate text-lg">{library.name}</CardTitle>
            <CardDescription className="mt-1 font-mono text-xs">
              {library.id} · {library.org}
            </CardDescription>
          </div>
          <div className="flex flex-wrap justify-end gap-1.5">
            <Badge variant={library.active ? "success" : "secondary"}>
              {library.active ? "Active" : "Archived"}
            </Badge>
            {library.active ? (
              <Badge variant={library.visible ? "outline" : "warning"}>
                {library.visible ? "Visible" : "Hidden"}
              </Badge>
            ) : null}
            <Badge variant="secondary">{library.scope}</Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <Count label="Sources" value={library.counts.sources} />
          <Count label="Modules" value={library.counts.modules} />
          <Count label="Users" value={library.counts.users} />
        </div>
        <dl className="grid gap-2 text-sm">
          <Detail label="Topics" value={library.topics.join(", ") || "None"} />
          <Detail label="Prefix" value={library.prefix || "None"} />
          <Detail
            label="Submodule container"
            value={library.submoduleContainer || "Auto-detect"}
          />
          <Detail label="Pipeline secret" value={library.pipelineSecret} mono />
          {library.scope === "global" ? (
            <Detail
              label="Repository access"
              value={library.publicOnly ? "Public only" : "Public and private"}
            />
          ) : null}
        </dl>
      </CardContent>
      <CardFooter className="gap-2">
        <Button onClick={onEdit} size="sm" type="button" variant="outline">
          <Pencil aria-hidden="true" className="mr-2 h-4 w-4" />
          Edit
        </Button>
        <Button
          onClick={onStatusChange}
          size="sm"
          type="button"
          variant={library.active ? "outline" : "default"}
        >
          {library.active ? (
            <Archive aria-hidden="true" className="mr-2 h-4 w-4" />
          ) : (
            <RotateCcw aria-hidden="true" className="mr-2 h-4 w-4" />
          )}
          {library.active ? "Archive" : "Restore"}
        </Button>
      </CardFooter>
    </Card>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-muted/50 p-2 text-center">
      <div className="font-semibold tabular-nums">{value}</div>
      <div className="text-muted-foreground text-xs">{label}</div>
    </div>
  );
}

function Detail({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono ? "break-all font-mono text-xs" : "break-words"}>
        {value}
      </dd>
    </div>
  );
}

function LibraryFormDialog({
  library,
  open,
  onOpenChange,
  onSaved,
}: {
  library: AdminModuleLibrary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (library: AdminModuleLibrary) => void;
}) {
  const editing = library !== null;
  const [form, setForm] = useState<LibraryFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm(
      library
        ? {
            id: library.id,
            name: library.name,
            scope: library.scope,
            org: library.org,
            topics: library.topics.join(", "),
            prefix: library.prefix ?? "",
            submoduleContainer: library.submoduleContainer ?? "",
            pipelineSecret: library.pipelineSecret,
            publicOnly: library.publicOnly,
            visible: library.visible,
          }
        : EMPTY_FORM,
    );
    setError(null);
  }, [library, open]);

  const setField = <K extends keyof LibraryFormState>(
    field: K,
    value: LibraryFormState[K],
  ) => setForm((current) => ({ ...current, [field]: value }));

  const save = async () => {
    setSaving(true);
    setError(null);

    const payload: Record<string, unknown> = {
      name: form.name.trim(),
      org: form.org.trim(),
      topics: form.topics
        .split(",")
        .map((topic) => topic.trim())
        .filter(Boolean),
      prefix: form.prefix.trim() || null,
      submoduleContainer: form.submoduleContainer.trim() || null,
      visible: form.visible,
    };
    if (form.pipelineSecret.trim()) {
      payload.pipelineSecret = form.pipelineSecret.trim();
    }
    if (form.scope === "global") payload.publicOnly = form.publicOnly;
    if (!editing) {
      payload.id = form.id.trim();
      payload.scope = form.scope;
    }

    try {
      const endpoint = editing
        ? `/api/admin/module-libraries/${encodeURIComponent(library.id)}`
        : "/api/admin/module-libraries";
      const response = await fetch(endpoint, {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(errorMessage(body, "Failed to save module library"));
      }

      onSaved(body.library as AdminModuleLibrary);
      onOpenChange(false);
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Failed to save module library",
      );
    } finally {
      setSaving(false);
    }
  };

  const fieldPrefix = editing ? `library-${library.id}` : "library-new";

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit library" : "Add library"}</DialogTitle>
          <DialogDescription>
            {editing
              ? `Update ${library.name}. Its id and scope cannot be changed.`
              : "Add a module catalogue source."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          {!editing ? (
            <Field id={`${fieldPrefix}-id`} label="ID">
              <Input
                id={`${fieldPrefix}-id`}
                onChange={(event) => setField("id", event.target.value)}
                placeholder="example-library"
                required
                value={form.id}
              />
            </Field>
          ) : null}
          <Field id={`${fieldPrefix}-name`} label="Name">
            <Input
              id={`${fieldPrefix}-name`}
              onChange={(event) => setField("name", event.target.value)}
              required
              value={form.name}
            />
          </Field>
          {!editing ? (
            <Field id={`${fieldPrefix}-scope`} label="Scope">
              <Select
                id={`${fieldPrefix}-scope`}
                onChange={(event) =>
                  setField("scope", event.target.value as LibraryScope)
                }
                value={form.scope}
              >
                <option value="global">Global</option>
                <option value="user">Per user</option>
              </Select>
            </Field>
          ) : null}
          <Field id={`${fieldPrefix}-org`} label="GitHub organisation">
            <Input
              id={`${fieldPrefix}-org`}
              onChange={(event) => setField("org", event.target.value)}
              required
              value={form.org}
            />
          </Field>
          <Field
            className="sm:col-span-2"
            id={`${fieldPrefix}-topics`}
            label="Topics (comma-separated)"
          >
            <Input
              id={`${fieldPrefix}-topics`}
              onChange={(event) => setField("topics", event.target.value)}
              placeholder="terraform, aws"
              value={form.topics}
            />
          </Field>
          <Field id={`${fieldPrefix}-prefix`} label="Repository prefix">
            <Input
              id={`${fieldPrefix}-prefix`}
              onChange={(event) => setField("prefix", event.target.value)}
              placeholder="terraform-"
              value={form.prefix}
            />
          </Field>
          <Field
            id={`${fieldPrefix}-submodule-container`}
            label="Submodule container"
          >
            <Input
              id={`${fieldPrefix}-submodule-container`}
              onChange={(event) =>
                setField("submoduleContainer", event.target.value)
              }
              placeholder="modules"
              value={form.submoduleContainer}
            />
          </Field>
          <Field
            className="sm:col-span-2"
            id={`${fieldPrefix}-pipeline-secret`}
            label="Pipeline secret"
          >
            <Input
              id={`${fieldPrefix}-pipeline-secret`}
              onChange={(event) =>
                setField("pipelineSecret", event.target.value)
              }
              placeholder="TERRABLOX_EXAMPLE_MODULES_TOKEN"
              value={form.pipelineSecret}
            />
          </Field>
        </div>

        <div className="space-y-3 rounded-md border p-3">
          <CheckboxField
            checked={form.visible}
            id={`${fieldPrefix}-visible`}
            label="Visible to users"
            onChange={(checked) => setField("visible", checked)}
          />
          {form.scope === "global" ? (
            <CheckboxField
              checked={form.publicOnly}
              id={`${fieldPrefix}-public-only`}
              label="Use public repositories only"
              onChange={(checked) => setField("publicOnly", checked)}
            />
          ) : null}
        </div>

        {error ? (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button
            disabled={saving}
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button disabled={saving} onClick={() => void save()} type="button">
            {saving ? (
              <Loader2
                aria-hidden="true"
                className="mr-2 h-4 w-4 animate-spin"
              />
            ) : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  id,
  label,
  children,
  className,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`space-y-2 ${className ?? ""}`}>
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

function CheckboxField({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        checked={checked}
        className="h-4 w-4 rounded border-input accent-primary"
        id={id}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      <Label htmlFor={id}>{label}</Label>
    </div>
  );
}

function LibraryStatusDialog({
  library,
  onOpenChange,
  onChanged,
}: {
  library: AdminModuleLibrary | null;
  onOpenChange: (open: boolean) => void;
  onChanged: (library: AdminModuleLibrary) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = library !== null;

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  if (!library) return null;

  const archive = library.active;
  const changeStatus = async () => {
    setSaving(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/admin/module-libraries/${encodeURIComponent(library.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ active: !library.active }),
        },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          errorMessage(
            body,
            archive ? "Failed to archive library" : "Failed to restore library",
          ),
        );
      }

      onChanged(body.library as AdminModuleLibrary);
      onOpenChange(false);
    } catch (statusError) {
      setError(
        statusError instanceof Error
          ? statusError.message
          : archive
            ? "Failed to archive library"
            : "Failed to restore library",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {archive ? "Archive library?" : "Restore library?"}
          </DialogTitle>
          <DialogDescription>
            {archive
              ? `${library.name} will become inactive. Its configuration and imported data will not be deleted.`
              : `${library.name} will become active again. Its existing configuration and imported data are retained.`}
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button
            disabled={saving}
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            disabled={saving}
            onClick={() => void changeStatus()}
            type="button"
            variant={archive ? "destructive" : "default"}
          >
            {saving ? (
              <Loader2
                aria-hidden="true"
                className="mr-2 h-4 w-4 animate-spin"
              />
            ) : archive ? (
              <Archive aria-hidden="true" className="mr-2 h-4 w-4" />
            ) : (
              <RotateCcw aria-hidden="true" className="mr-2 h-4 w-4" />
            )}
            {archive ? "Archive library" : "Restore library"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
