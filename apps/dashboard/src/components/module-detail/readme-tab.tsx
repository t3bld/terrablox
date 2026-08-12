"use client";

import { Skeleton } from "@terrablox/ui/skeleton";
import { AlertCircle, FileText, Loader2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface ReadmeTabProps {
  markdown: string | null;
  loading: boolean;
  error: string | null;
  /** Base for resolving relative image paths, e.g. a raw.githubusercontent URL. */
  imageBaseUrl?: string | null;
}

function EmptyState(props: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-12 text-center">
      <div className="text-muted-foreground">{props.icon}</div>
      <div className="text-sm text-muted-foreground">{props.children}</div>
    </div>
  );
}

/**
 * Relative image and link targets in a README are resolved against the repo,
 * not against this app, so they have to be rewritten to survive rendering.
 */
function resolveUrl(src: string, base: string | null | undefined) {
  if (!base) return src;
  if (/^(https?:|data:|#|mailto:)/i.test(src)) return src;

  try {
    return new URL(
      src.replace(/^\.\//, ""),
      `${base.replace(/\/$/, "")}/`,
    ).toString();
  } catch {
    return src;
  }
}

export function ReadmeTab({
  markdown,
  loading,
  error,
  imageBaseUrl,
}: ReadmeTabProps) {
  if (loading) {
    return (
      <div className="space-y-3 rounded-lg border p-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading README…
        </div>
        <Skeleton className="h-7 w-1/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-4/6" />
        <Skeleton className="mt-6 h-24 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState icon={<AlertCircle className="h-8 w-8" />}>
        {error}
      </EmptyState>
    );
  }

  if (!markdown?.trim()) {
    return (
      <EmptyState icon={<FileText className="h-8 w-8" />}>
        This module has no README.
      </EmptyState>
    );
  }

  return (
    <div className="min-w-0 overflow-hidden rounded-lg border bg-card">
      <div
        className="
          prose prose-sm dark:prose-invert max-w-none p-6
          prose-headings:scroll-mt-20
          prose-h1:text-2xl prose-h1:font-semibold prose-h1:tracking-tight
          prose-h1:mb-4 prose-h1:pb-2 prose-h1:border-b
          prose-h2:text-xl prose-h2:font-semibold prose-h2:mt-8
          prose-h2:pb-2 prose-h2:border-b
          prose-h3:text-base prose-h3:font-semibold
          prose-a:font-medium prose-a:underline-offset-4
          prose-code:rounded prose-code:bg-muted prose-code:px-1.5
          prose-code:py-0.5 prose-code:font-normal prose-code:text-foreground
          prose-code:before:content-none prose-code:after:content-none
          prose-pre:border prose-pre:bg-muted prose-pre:text-foreground
          prose-img:rounded-md prose-img:border
          prose-table:text-sm
          prose-th:border prose-th:bg-muted/60 prose-th:px-3 prose-th:py-2
          prose-td:border prose-td:px-3 prose-td:py-2
          prose-blockquote:border-l-primary/40 prose-blockquote:not-italic
          break-words
        "
      >
        <ReactMarkdown
          components={{
            a: ({ href, children, ...rest }) => (
              <a
                {...rest}
                href={resolveUrl(href ?? "", imageBaseUrl)}
                rel="noreferrer noopener"
                target="_blank"
              >
                {children}
              </a>
            ),
            img: ({ src, alt, ...rest }) => (
              // biome-ignore lint/performance/noImgElement: README images point at arbitrary remote hosts, which next/image cannot serve without per-host config
              <img
                {...rest}
                alt={alt ?? ""}
                loading="lazy"
                src={resolveUrl(
                  typeof src === "string" ? src : "",
                  imageBaseUrl,
                )}
              />
            ),
            table: ({ children, ...rest }) => (
              // Wide tables must scroll inside the card instead of widening the page.
              <div className="my-4 w-full overflow-x-auto">
                <table {...rest}>{children}</table>
              </div>
            ),
          }}
          remarkPlugins={[remarkGfm]}
        >
          {markdown}
        </ReactMarkdown>
      </div>
    </div>
  );
}
