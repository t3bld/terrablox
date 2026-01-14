"use client";

import { GitBranch } from "lucide-react";
import { useState } from "react";

import { Button } from "@terrablox/ui/button";

import { ImportModuleDialog } from "@/components/import-module-dialog";

export function ModuleImportActions() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
      >
        <GitBranch className="mr-2 h-4 w-4" />
        Import from GitHub
      </Button>

      <ImportModuleDialog
        provider="github"
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
