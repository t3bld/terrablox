"use client";

import { Button } from "@terrablox/ui/button";
import {
  CheckCircle2,
  Download,
  FileText,
  Loader2,
  Trash2,
  Upload,
} from "lucide-react";
import { useId, useRef, useState } from "react";

import type { ProjectContextDocumentDto } from "@/lib/projects/types";

const ACCEPTED = ".pdf,.docx,.txt,.md,.markdown";
const MAX_DOCUMENTS = 10;

function size(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function ContextDocumentManager({
  documents,
  onChange,
  projectId,
  disabled = false,
}: {
  documents: ProjectContextDocumentDto[];
  onChange: (documents: ProjectContextDocumentDto[]) => void;
  /** Absent while the import dialog is staging files before project creation. */
  projectId?: string;
  disabled?: boolean;
}) {
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<string[]>([]);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function upload(files: File[]) {
    if (disabled || files.length === 0) return;
    const remaining = MAX_DOCUMENTS - documents.length;
    if (remaining <= 0) {
      setError(
        `A project may have at most ${MAX_DOCUMENTS} context documents.`,
      );
      return;
    }

    const accepted = files.slice(0, remaining);
    setError(
      files.length > accepted.length
        ? `Only the first ${accepted.length} file(s) fit the ${MAX_DOCUMENTS}-document limit.`
        : null,
    );

    let next = [...documents];
    for (const file of accepted) {
      setUploading((current) => [...current, file.name]);
      try {
        const form = new FormData();
        form.set("file", file);
        const response = await fetch(
          projectId
            ? `/api/projects/${projectId}/documents`
            : "/api/project-context-documents",
          { method: "POST", body: form },
        );
        const body = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(body?.error ?? `Could not upload ${file.name}.`);
        }
        next = [...next, body.document as ProjectContextDocumentDto];
        onChange(next);
      } catch (uploadError) {
        setError(
          uploadError instanceof Error
            ? uploadError.message
            : `Could not upload ${file.name}.`,
        );
      } finally {
        setUploading((current) => current.filter((name) => name !== file.name));
      }
    }
  }

  async function remove(document: ProjectContextDocumentDto) {
    if (disabled) return;
    setRemoving(document.id);
    setError(null);

    try {
      const response = await fetch(
        projectId
          ? `/api/projects/${projectId}/documents/${document.id}`
          : `/api/project-context-documents/${document.id}`,
        { method: "DELETE" },
      );
      if (!response.ok && response.status !== 404) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? "The document was not removed.");
      }
      onChange(documents.filter((entry) => entry.id !== document.id));
    } catch (removeError) {
      setError(
        removeError instanceof Error
          ? removeError.message
          : "The document was not removed.",
      );
    } finally {
      setRemoving(null);
    }
  }

  const full = documents.length >= MAX_DOCUMENTS;

  return (
    <div className="space-y-3">
      <input
        accept={ACCEPTED}
        className="sr-only"
        disabled={disabled || full}
        id={inputId}
        multiple
        onChange={(event) => {
          void upload(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
        ref={input}
        type="file"
      />

      <button
        className="flex w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-muted/20 px-4 py-5 text-center transition-colors hover:border-primary/50 hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-60"
        disabled={disabled || full}
        onClick={() => input.current?.click()}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          void upload(Array.from(event.dataTransfer.files));
        }}
        type="button"
      >
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-background shadow-sm ring-1 ring-border">
          <Upload className="h-4 w-4 text-muted-foreground" />
        </span>
        <span className="font-medium text-sm">
          {full
            ? "Document limit reached"
            : "Drop documents here or choose files"}
        </span>
        <span className="text-muted-foreground text-xs">
          PDF, DOCX, TXT or Markdown · up to 10 MB each
        </span>
      </button>

      {uploading.map((name) => (
        <div
          className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-xs"
          key={`uploading-${name}`}
        >
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">Extracting {name}…</span>
        </div>
      ))}

      {documents.length ? (
        <ul className="divide-y rounded-md border bg-card">
          {documents.map((document) => (
            <li className="flex items-center gap-3 px-3 py-2" key={document.id}>
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p
                  className="truncate font-medium text-xs"
                  title={document.name}
                >
                  {document.name}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {size(document.byteSize)} ·{" "}
                  {document.characterCount.toLocaleString()} characters
                  extracted
                </p>
              </div>
              <CheckCircle2
                aria-label="Ready for the agent"
                className="h-4 w-4 shrink-0 text-emerald-600"
              />
              {document.downloadUrl ? (
                <Button asChild className="h-7 w-7" size="icon" variant="ghost">
                  <a
                    aria-label={`Download ${document.name}`}
                    href={document.downloadUrl}
                  >
                    <Download className="h-3.5 w-3.5" />
                  </a>
                </Button>
              ) : null}
              <Button
                aria-label={`Remove ${document.name}`}
                className="h-7 w-7"
                disabled={disabled || removing === document.id}
                onClick={() => void remove(document)}
                size="icon"
                type="button"
                variant="ghost"
              >
                {removing === document.id ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {error ? (
        <p className="text-destructive text-xs" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
