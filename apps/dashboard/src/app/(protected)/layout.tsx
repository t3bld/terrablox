"use client";

import { Skeleton } from "@terrablox/ui/skeleton";
import { useEffect, useState } from "react";

/**
 * Protected layout.
 *
 * Auth gating and redirects are handled in `src/middleware.ts`.
 * This layout only provides a small hydration/loading UX.
 */
export default function ProtectedAppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Avoid layout flicker during the first client render.
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Skeleton className="h-12 w-12 rounded-full" />
          <Skeleton className="h-4 w-32" />
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
