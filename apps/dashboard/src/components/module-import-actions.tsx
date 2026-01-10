"use client";

import { GitBranch, Upload } from "lucide-react";
import { useState } from "react";

import { Button } from "@terrablox/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@terrablox/ui/dropdown-menu";

import { ImportModuleDialog } from "@/components/import-module-dialog";

export function ModuleImportActions() {
  const [importProvider, setImportProvider] = useState<"github" | null>(null);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline">
            <GitBranch className="h-4 w-4 mr-2" />
            Import from...
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onClick={() => setImportProvider("github")}>
            GitHub
          </DropdownMenuItem>
          <DropdownMenuItem disabled>GitLab (coming soon)</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Button size="sm">
        <Upload className="h-4 w-4 mr-2" />
        Upload Module
      </Button>

      {importProvider ? (
        <ImportModuleDialog
          provider={importProvider}
          open={!!importProvider}
          onOpenChange={(open) => {
            if (!open) setImportProvider(null);
          }}
        />
      ) : null}
    </>
  );
}
