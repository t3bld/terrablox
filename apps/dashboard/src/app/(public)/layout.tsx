"use client";

import { useAuth } from "@terrablox/auth";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Public layout.
 *
 * Redirecting authenticated users away from auth routes is handled in `src/middleware.ts`.
 * This layout adds a client-side redirect as a fallback for when the auth state
 * changes *after* the page has loaded (e.g., after a successful login).
 */
export default function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { isLoading, isAuthenticated } = useAuth();

  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated) return;

    const sp = new URLSearchParams(window.location.search);
    const next = sp.get("next");
    router.replace(next || "/projects");
  }, [isLoading, isAuthenticated, router]);

  return <>{children}</>;
}
