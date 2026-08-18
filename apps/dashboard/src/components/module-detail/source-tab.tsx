"use client";

import { languageFromFilename } from "@terrablox/code-viewer/language";
import { Button } from "@terrablox/ui/button";
import { Input } from "@terrablox/ui/input";
import { cn } from "@terrablox/ui/lib/utils";
import { Skeleton } from "@terrablox/ui/skeleton";
import {
  AlertCircle,
  ChevronRight,
  ExternalLink,
  FileCode2,
  File as FileIcon,
  Folder,
  FolderOpen,
  Loader2,
  Search,
} from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Monaco touches `window`/`self` at import time, so it must never be rendered
// on the server.
const CodeViewer = dynamic(
  () => import("@terrablox/code-viewer/code-viewer").then((m) => m.CodeViewer),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading editor…
      </div>
    ),
  },
);

interface SourceTabProps {
  owner: string | null;
  repo: string | null;
  /** Named `gitRef` because React intercepts a prop literally called `ref`. */
  gitRef: string | null;
  /** Subfolder the module was imported from; used as the initial tree root. */
  rootFolder: string | null;
  repoUrl: string | null;
}

interface TreeNode {
  name: string;
  path: string;
  type: "tree" | "blob";
  children: TreeNode[];
}

const MAX_FILE_BYTES = 512 * 1024;

function buildTree(
  paths: { path: string; type: "tree" | "blob" }[],
): TreeNode[] {
  const root: TreeNode = { name: "", path: "", type: "tree", children: [] };

  for (const entry of [...paths].sort((a, b) => a.path.localeCompare(b.path))) {
    const segments = entry.path.split("/").filter(Boolean);
    let current = root;

    segments.forEach((segment, index) => {
      const isLeaf = index === segments.length - 1;
      const path = segments.slice(0, index + 1).join("/");
      let child = current.children.find((c) => c.name === segment);

      if (!child) {
        child = {
          name: segment,
          path,
          type: isLeaf ? entry.type : "tree",
          children: [],
        };
        current.children.push(child);
      }

      current = child;
    });
  }

  const sort = (node: TreeNode): TreeNode => ({
    ...node,
    children: node.children
      .map(sort)
      // Directories first, then alphabetical — the convention every IDE uses.
      .sort((a, b) =>
        a.type === b.type
          ? a.name.localeCompare(b.name)
          : a.type === "tree"
            ? -1
            : 1,
      ),
  });

  return sort(root).children;
}

function isTerraformFile(path: string) {
  return /\.(tf|tfvars)(\.json)?$/i.test(path);
}

function TreeItem({
  node,
  depth,
  selectedPath,
  expanded,
  onToggle,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  const isOpen = expanded.has(node.path);
  const isSelected = selectedPath === node.path;

  if (node.type === "tree") {
    return (
      <li>
        <button
          className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-sm hover:bg-muted"
          onClick={() => onToggle(node.path)}
          style={{ paddingLeft: `${depth * 12 + 6}px` }}
          type="button"
        >
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
              isOpen && "rotate-90",
            )}
          />
          {isOpen ? (
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{node.name}</span>
        </button>

        {isOpen ? (
          <ul>
            {node.children.map((child) => (
              <TreeItem
                depth={depth + 1}
                expanded={expanded}
                key={child.path}
                node={child}
                onSelect={onSelect}
                onToggle={onToggle}
                selectedPath={selectedPath}
              />
            ))}
          </ul>
        ) : null}
      </li>
    );
  }

  return (
    <li>
      <button
        aria-current={isSelected ? "page" : undefined}
        className={cn(
          "flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-sm hover:bg-muted",
          isSelected && "bg-accent font-medium text-accent-foreground",
        )}
        onClick={() => onSelect(node.path)}
        style={{ paddingLeft: `${depth * 12 + 6}px` }}
        title={node.path}
        type="button"
      >
        {isTerraformFile(node.path) ? (
          <FileCode2 className="ml-[14px] h-3.5 w-3.5 shrink-0 text-primary" />
        ) : (
          <FileIcon className="ml-[14px] h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate">{node.name}</span>
      </button>
    </li>
  );
}

export function SourceTab({
  owner,
  repo,
  gitRef,
  rootFolder,
  repoUrl,
}: SourceTabProps) {
  const [entries, setEntries] = useState<
    { path: string; type: "tree" | "blob" }[] | null
  >(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [treeLoading, setTreeLoading] = useState(false);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");

  // Avoids showing the content of a file the user has already navigated away from.
  const requestRef = useRef(0);

  useEffect(() => {
    if (!owner || !repo || !gitRef) return;

    let cancelled = false;
    setTreeLoading(true);
    setTreeError(null);

    fetch(
      `/api/git-provider/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
        repo,
      )}/tree?ref=${encodeURIComponent(gitRef)}`,
    )
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(
            typeof body?.error === "string"
              ? body.error
              : "Failed to load tree",
          );
        }
        return (body?.entries ?? []) as {
          path: string;
          type: "tree" | "blob";
        }[];
      })
      .then((list) => {
        if (cancelled) return;
        setEntries(list);

        // Open the imported module folder so the relevant files are visible.
        const initial = new Set<string>();
        if (rootFolder && rootFolder !== ".") {
          const segments = rootFolder.split("/").filter(Boolean);
          segments.forEach((_, i) => {
            initial.add(segments.slice(0, i + 1).join("/"));
          });
        }
        setExpanded(initial);

        const prefix = rootFolder && rootFolder !== "." ? `${rootFolder}/` : "";
        const firstTf = list.find(
          (e) =>
            e.type === "blob" &&
            e.path.startsWith(prefix) &&
            /\.tf$/i.test(e.path),
        );
        setSelectedPath(firstTf?.path ?? null);
      })
      .catch((e) => {
        if (!cancelled) {
          setTreeError(e instanceof Error ? e.message : "Failed to load tree");
        }
      })
      .finally(() => {
        if (!cancelled) setTreeLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [owner, repo, gitRef, rootFolder]);

  useEffect(() => {
    if (!owner || !repo || !gitRef || !selectedPath) {
      setFileContent(null);
      return;
    }

    const requestId = ++requestRef.current;
    setFileLoading(true);
    setFileError(null);

    fetch(
      `/api/git-provider/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
        repo,
      )}/contents?ref=${encodeURIComponent(gitRef)}&path=${encodeURIComponent(
        selectedPath,
      )}`,
    )
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(
            typeof body?.error === "string"
              ? body.error
              : "Failed to load file",
          );
        }
        return body as {
          content?: unknown;
          encoding?: unknown;
          size?: unknown;
        };
      })
      .then((body) => {
        if (requestId !== requestRef.current) return;

        if (typeof body.size === "number" && body.size > MAX_FILE_BYTES) {
          throw new Error("File is too large to display.");
        }
        if (typeof body.content !== "string" || body.encoding !== "base64") {
          throw new Error("This file is not a readable text blob.");
        }

        // atob yields latin1; round-tripping through TextDecoder restores UTF-8.
        const binary = atob(body.content.replace(/\n/g, ""));
        const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
        setFileContent(new TextDecoder().decode(bytes));
      })
      .catch((e) => {
        if (requestId !== requestRef.current) return;
        setFileContent(null);
        setFileError(e instanceof Error ? e.message : "Failed to load file");
      })
      .finally(() => {
        if (requestId === requestRef.current) setFileLoading(false);
      });
  }, [owner, repo, gitRef, selectedPath]);

  const handleToggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const needle = filter.trim().toLowerCase();

  const tree = useMemo(() => {
    if (!entries) return [];
    const visible = needle
      ? entries.filter(
          (e) => e.type === "blob" && e.path.toLowerCase().includes(needle),
        )
      : entries;
    return buildTree(visible);
  }, [entries, needle]);

  // A filtered tree is useless collapsed, so expand everything while filtering.
  const effectiveExpanded = useMemo(() => {
    if (!needle) return expanded;
    const all = new Set<string>();
    const walk = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        if (node.type === "tree") {
          all.add(node.path);
          walk(node.children);
        }
      }
    };
    walk(tree);
    return all;
  }, [needle, expanded, tree]);

  if (!owner || !repo || !gitRef) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-12 text-center">
        <AlertCircle className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          Source browsing requires a GitHub repository and a version tag.
        </p>
        {repoUrl ? (
          <Button asChild size="sm" variant="outline">
            <a href={repoUrl} rel="noreferrer" target="_blank">
              <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
              Open repository
            </a>
          </Button>
        ) : null}
      </div>
    );
  }

  const language = selectedPath
    ? languageFromFilename(selectedPath)
    : undefined;

  return (
    <div className="grid gap-3 lg:grid-cols-[280px_minmax(0,1fr)]">
      <aside className="flex h-[640px] flex-col overflow-hidden rounded-lg border bg-card">
        <div className="border-b p-2">
          <div className="relative rounded-md border border-input bg-background focus-within:border-primary">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="h-8 border-0 pl-8 text-xs focus-visible:ring-0 focus-visible:ring-offset-0"
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Find file…"
              type="search"
              value={filter}
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-1">
          {treeLoading ? (
            <div className="space-y-2 p-2">
              {Array.from({ length: 8 }, (_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton rows
                <Skeleton className="h-4 w-full" key={i} />
              ))}
            </div>
          ) : treeError ? (
            <p className="p-3 text-xs text-destructive">{treeError}</p>
          ) : tree.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">
              {needle ? "No files match." : "Repository is empty."}
            </p>
          ) : (
            <ul>
              {tree.map((node) => (
                <TreeItem
                  depth={0}
                  expanded={effectiveExpanded}
                  key={node.path}
                  node={node}
                  onSelect={setSelectedPath}
                  onToggle={handleToggle}
                  selectedPath={selectedPath}
                />
              ))}
            </ul>
          )}
        </div>
      </aside>

      <div className="h-[640px] overflow-hidden rounded-lg border bg-card">
        {fileError ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <AlertCircle className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{fileError}</p>
          </div>
        ) : fileLoading || fileContent === null ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            {fileLoading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading file…
              </>
            ) : (
              "Select a file to view its source."
            )}
          </div>
        ) : (
          <CodeViewer
            filename={selectedPath ?? undefined}
            height="100%"
            {...(language ? { language } : {})}
            options={{ readOnly: true, minimap: { enabled: true } }}
            value={fileContent}
            wordWrap="on"
          />
        )}
      </div>
    </div>
  );
}
