"use client";

import { Button } from "@terrablox/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@terrablox/ui/dialog";
import { AlertTriangle, Loader2, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import type { DeleteScope } from "@/lib/terraform/delete-scope";

interface DeleteImpact {
  scope: DeleteScope;
  versionCount: number;
  submoduleCount: number;
  canvasNodeCount: number;
  projects: { id: string; name: string }[];
  isLastVersion: boolean;
}

interface DeleteModuleDialogProps {
  moduleId: string;
  moduleName: string;
  versionTag: string | null;
  scope: DeleteScope;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: (moduleId: string, scope: DeleteScope) => void;
}

function ImpactRow({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span
        aria-hidden
        className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-current"
      />
      <span>{children}</span>
    </li>
  );
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function DeleteModuleDialog({
  moduleId,
  moduleName,
  versionTag,
  scope,
  open,
  onOpenChange,
  onDeleted,
}: DeleteModuleDialogProps) {
  const [impact, setImpact] = useState<DeleteImpact | null>(null);
  const [impactLoading, setImpactLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    setImpact(null);
    setError(null);
    setImpactLoading(true);

    fetch(`/api/modules/${encodeURIComponent(moduleId)}/impact?scope=${scope}`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(
            typeof body?.error === "string"
              ? body.error
              : "Failed to load impact",
          );
        }
        return body.impact as DeleteImpact;
      })
      .then((value) => {
        if (!cancelled) setImpact(value);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load impact");
        }
      })
      .finally(() => {
        if (!cancelled) setImpactLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, moduleId, scope]);

  const handleDelete = () => {
    setDeleting(true);
    setError(null);

    fetch(`/api/modules/${encodeURIComponent(moduleId)}?scope=${scope}`, {
      method: "DELETE",
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(
            typeof body?.error === "string" ? body.error : "Failed to delete",
          );
        }
      })
      .then(() => {
        onOpenChange(false);
        onDeleted(moduleId, scope);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : "Failed to delete module");
      })
      .finally(() => setDeleting(false));
  };

  const hasCascade =
    (impact?.submoduleCount ?? 0) > 0 ||
    (impact?.projects.length ?? 0) > 0 ||
    (impact?.versionCount ?? 0) > 1;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {scope === "module" ? "Delete module?" : "Delete version?"}
          </DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{moduleName}</span>
            {scope === "module" ? (
              " and all of its imported versions will be removed."
            ) : (
              <>
                {" at "}
                <code className="font-mono text-xs">
                  {versionTag ?? "(no ref)"}
                </code>
                {" will be removed."}
              </>
            )}
            {" This cannot be undone."}
          </DialogDescription>
        </DialogHeader>

        {impactLoading ? (
          <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking what depends on this module…
          </div>
        ) : impact ? (
          hasCascade || impact.isLastVersion ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              <div className="flex items-center gap-2 font-medium">
                <AlertTriangle className="h-4 w-4" />
                This also removes
              </div>

              <ul className="mt-2 space-y-1">
                {impact.versionCount > 1 ? (
                  <ImpactRow>
                    {plural(impact.versionCount, "version")}
                  </ImpactRow>
                ) : null}

                {impact.submoduleCount > 0 ? (
                  <ImpactRow>
                    {plural(impact.submoduleCount, "submodule")}
                  </ImpactRow>
                ) : null}

                {impact.projects.length > 0 ? (
                  <ImpactRow>
                    {plural(impact.canvasNodeCount, "canvas node")} and their
                    connections in{" "}
                    <span className="font-medium">
                      {impact.projects.map((p) => p.name).join(", ")}
                    </span>
                  </ImpactRow>
                ) : null}

                {impact.isLastVersion ? (
                  <ImpactRow>
                    the last imported version, so its name, description and tags
                    are dropped too
                  </ImpactRow>
                ) : null}
              </ul>
            </div>
          ) : (
            <p className="py-1 text-sm text-muted-foreground">
              Nothing else depends on this module.
            </p>
          )
        ) : null}

        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button
            disabled={deleting}
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            // Deleting before the impact is known would defeat the warning.
            disabled={deleting || impactLoading}
            onClick={handleDelete}
            type="button"
            variant="destructive"
          >
            {deleting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="mr-2 h-4 w-4" />
            )}
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
