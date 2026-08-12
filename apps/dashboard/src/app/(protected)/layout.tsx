"use client";

import { useAuth } from "@terrablox/auth/hooks";
import { Skeleton } from "@terrablox/ui/skeleton";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

function LoadingScreen() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <Skeleton className="h-12 w-12 rounded-full" />
        <Skeleton className="h-4 w-32" />
      </div>
    </div>
  );
}

/**
 * Protected layout.
 *
 * `src/middleware.ts` runs on the Edge runtime and can only check that a
 * session cookie *exists*, not that it is still valid. A stale cookie - after
 * the session expired or `BETTER_AUTH_SECRET` changed - therefore passes the
 * middleware while the server rejects the session.
 *
 * Without the recovery below the user is trapped: the page renders nothing and
 * `/login` redirects straight back here because the cookie is still present.
 * Signing out clears the cookie and breaks the loop.
 */
export default function ProtectedAppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { isLoading, isAuthenticated, signOut } = useAuth();
  const pathname = usePathname();
  // Avoid layout flicker during the first client render.
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted || isLoading || isAuthenticated) {
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        await signOut();
      } catch {
        // Already invalid server-side; the redirect still has to happen.
      }
      if (!cancelled) {
        const next = pathname ? `?next=${encodeURIComponent(pathname)}` : "";
        window.location.replace(`/login${next}`);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [mounted, isLoading, isAuthenticated, signOut, pathname]);

  // Covers the unauthenticated case too, so a blank page is never rendered
  // while the redirect above is in flight.
  if (!mounted || isLoading || !isAuthenticated) {
    return <LoadingScreen />;
  }

  return <>{children}</>;
}
