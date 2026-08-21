"use client";

import { useAuth } from "@terrablox/auth/hooks";
import { Skeleton } from "@terrablox/ui/skeleton";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { GithubConnectionBanner } from "@/components/github-connection-banner";

/**
 * The app shell, empty.
 *
 * This is shown on every hard load, because the session is resolved in the
 * browser: a route's own `loading.tsx` only takes over once that is done. It used
 * to be a small circle in the middle of a blank page, which is indistinguishable
 * from a page that has given up — the complaint that a screen "takes forever"
 * was largely this, arriving before the screen had started loading at all.
 *
 * Drawn by hand rather than through `PageSkeleton`: the real shell reads the
 * signed-in user, which is the thing not known yet.
 */
function LoadingScreen() {
  return (
    <div className="flex min-h-screen">
      <div className="hidden w-64 shrink-0 flex-col gap-4 border-r p-4 md:flex">
        <Skeleton className="h-8 w-32" />
        <div className="mt-2 space-y-2">
          {["nav-1", "nav-2", "nav-3", "nav-4"].map((key) => (
            <Skeleton className="h-8 w-full" key={key} />
          ))}
        </div>
        <Skeleton className="mt-auto h-10 w-full" />
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-16 shrink-0 items-center gap-3 border-b px-6">
          <Skeleton className="h-4 w-4" />
          <Skeleton className="h-4 w-40" />
        </div>
        <div className="flex-1 space-y-4 p-6">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
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

  // Above every protected screen, because losing the GitHub connection breaks
  // all of them at once and each one would otherwise report it as its own
  // unrelated failure.
  return (
    <>
      <GithubConnectionBanner />
      {children}
    </>
  );
}
