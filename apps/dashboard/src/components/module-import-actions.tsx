"use client";

import { Button } from "@terrablox/ui/button";
import { GitBranch } from "lucide-react";
import { useState } from "react";

import { ImportModuleDialog } from "@/components/import-module-dialog";

export function ModuleImportActions({
  onImported,
}: {
  /** Called after a module was successfully imported, so the caller can refresh. */
  onImported?: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <GitBranch className="mr-2 h-4 w-4" />
        Import from GitHub
      </Button>

      <ImportModuleDialog
        provider="github"
        open={open}
        onOpenChange={setOpen}
        {...(onImported ? { onImported } : {})}
      />
    </>
  );
}
