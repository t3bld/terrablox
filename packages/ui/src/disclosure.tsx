"use client";

import { ChevronDown } from "lucide-react";
import type * as React from "react";
import { cn } from "./lib/utils";

export function Disclosure({
  children,
  className,
  title,
}: {
  children: React.ReactNode;
  className?: string;
  title: React.ReactNode;
}) {
  return (
    <details className={cn("group rounded-md border bg-card", className)}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-md px-4 py-3 text-sm font-medium outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 [&::-webkit-details-marker]:hidden">
        {title}
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-4 border-t p-4">{children}</div>
    </details>
  );
}
