"use client";

import { useAuth } from "@terrablox/auth/hooks";
import { Card, CardContent } from "@terrablox/ui/card";
import { Input } from "@terrablox/ui/input";
import { Separator } from "@terrablox/ui/separator";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@terrablox/ui/sidebar";
import { Boxes, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { ModuleImportActions } from "@/components/module-import-actions";

interface Module {
  id: string;
  name: string;
  description: string;
}

export default function ModulesPage() {
  const { isAuthenticated } = useAuth();
  const [modules] = useState<Module[]>([]);
  const [searchQuery, setSearchQuery] = useState("");

  const filteredModules = useMemo(() => {
    if (!searchQuery.trim()) return modules;
    const query = searchQuery.toLowerCase();
    return modules.filter(
      (module) =>
        module.name.toLowerCase().includes(query) ||
        module.description.toLowerCase().includes(query),
    );
  }, [modules, searchQuery]);

  if (!isAuthenticated) {
    return null;
  }

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 h-4" />
          <h1 className="text-lg font-semibold">Terraform Module Library</h1>
          <div className="ml-auto flex items-center gap-2">
            <ModuleImportActions />
          </div>
        </header>

        <main className="flex-1 p-6">
          <div className="relative mb-6">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search modules..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 max-w-md"
            />
          </div>

          {filteredModules.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center justify-center py-12">
                <div className="rounded-full bg-muted p-4 mb-4">
                  <Boxes className="h-8 w-8 text-muted-foreground" />
                </div>
                <h3 className="text-lg font-semibold mb-1">No modules yet</h3>
                <p className="text-muted-foreground text-center mb-4">
                  Import a GitHub repository to create your first module.
                </p>
                <ModuleImportActions />
              </CardContent>
            </Card>
          ) : null}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
