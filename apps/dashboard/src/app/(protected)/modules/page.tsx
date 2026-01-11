"use client";

import {
  Boxes,
  Download,
  MoreVertical,
  Package,
  Search,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@terrablox/ui/card";
import { Input } from "@terrablox/ui/input";
import { Separator } from "@terrablox/ui/separator";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@terrablox/ui/sidebar";
import { Skeleton } from "@terrablox/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@terrablox/ui/dropdown-menu";
import { Button } from "@terrablox/ui/button";

import { AppSidebar } from "@/components/app-sidebar";
import { ModuleImportActions } from "@/components/module-import-actions";
import { useAuth } from "@terrablox/auth/hooks";

// Mock module type - replace with actual type from database
interface Module {
  id: string;
  name: string;
  description: string;
  version: string;
  size: string;
  uploadedAt: Date;
  downloads: number;
}

// Mock data - replace with actual data fetching
const mockModules: Module[] = [
  {
    id: "1",
    name: "terrain-generator",
    description: "Procedural terrain generation module with various biomes",
    version: "1.2.0",
    size: "2.4 MB",
    uploadedAt: new Date("2025-12-15"),
    downloads: 234,
  },
  {
    id: "2",
    name: "water-system",
    description: "Realistic water physics and rendering",
    version: "0.9.1",
    size: "1.8 MB",
    uploadedAt: new Date("2025-12-20"),
    downloads: 156,
  },
  {
    id: "3",
    name: "vegetation-pack",
    description: "Collection of trees, plants, and foliage assets",
    version: "2.0.0",
    size: "15.2 MB",
    uploadedAt: new Date("2026-01-02"),
    downloads: 89,
  },
];

export default function ModulesPage() {
  const { user, isAuthenticated } = useAuth();
  const [modules, setModules] = useState<Module[]>([]);
  const [modulesLoading, setModulesLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    // Simulate fetching modules
    async function fetchModules() {
      if (user?.id) {
        try {
          // TODO: Replace with actual API call
          await new Promise((resolve) => setTimeout(resolve, 500));
          setModules(mockModules);
        } catch {
          setModules([]);
        } finally {
          setModulesLoading(false);
        }
      }
    }

    if (isAuthenticated && user?.id) {
      fetchModules();
    }
  }, [isAuthenticated, user?.id]);

  const filteredModules = useMemo(() => {
    if (!searchQuery.trim()) return modules;
    const query = searchQuery.toLowerCase();
    return modules.filter(
      (module) =>
        module.name.toLowerCase().includes(query) ||
        module.description.toLowerCase().includes(query),
    );
  }, [modules, searchQuery]);

  // Only show the local loader while we're fetching module data.
  if (modulesLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Skeleton className="h-12 w-12 rounded-full" />
          <Skeleton className="h-4 w-32" />
        </div>
      </div>
    );
  }

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
          {/* Search Bar */}
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
                  {searchQuery ? (
                    <Search className="h-8 w-8 text-muted-foreground" />
                  ) : (
                    <Boxes className="h-8 w-8 text-muted-foreground" />
                  )}
                </div>
                <h3 className="text-lg font-semibold mb-1">
                  {searchQuery ? "No modules found" : "No modules yet"}
                </h3>
                <p className="text-muted-foreground text-center mb-4">
                  {searchQuery
                    ? `No modules match "${searchQuery}". Try a different search.`
                    : "Upload your first module to get started."}
                </p>
                {!searchQuery && <ModuleImportActions />}
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredModules.map((module) => (
                <Card
                  key={module.id}
                  className="group hover:border-primary/50 hover:shadow-md transition-all"
                >
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2">
                        <div className="rounded-md bg-primary/10 p-2">
                          <Package className="h-4 w-4 text-primary" />
                        </div>
                        <div>
                          <CardTitle className="text-base">
                            {module.name}
                          </CardTitle>
                          <span className="text-xs text-muted-foreground">
                            v{module.version}
                          </span>
                        </div>
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem>
                            <Download className="h-4 w-4 mr-2" />
                            Download
                          </DropdownMenuItem>
                          <DropdownMenuItem className="text-destructive focus:text-destructive">
                            <Trash2 className="h-4 w-4 mr-2" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    <CardDescription className="text-sm line-clamp-2 mt-2">
                      {module.description}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>{module.size}</span>
                      <span>{module.downloads} downloads</span>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
