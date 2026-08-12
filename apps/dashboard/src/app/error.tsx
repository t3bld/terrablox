"use client";

import { Button } from "@terrablox/ui/button";
import { useEffect } from "react";

/**
 * Without an error boundary a client-side exception unmounts the whole tree
 * and leaves a blank page with no indication of what went wrong.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-md space-y-4 text-center">
        <h1 className="text-lg font-semibold">Something went wrong</h1>
        <p className="text-sm text-muted-foreground">
          {error.message || "An unexpected error occurred."}
        </p>
        {error.digest ? (
          <p className="text-xs text-muted-foreground font-mono">
            {error.digest}
          </p>
        ) : null}
        <div className="flex justify-center gap-2">
          <Button onClick={reset}>Try again</Button>
          <Button variant="secondary" asChild>
            <a href="/login">Back to sign in</a>
          </Button>
        </div>
      </div>
    </div>
  );
}
