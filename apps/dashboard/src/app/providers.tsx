"use client";

/**
 * App Providers
 *
 * Wraps the app with necessary providers (Auth, etc.)
 */

import { AuthProvider } from "@terrablox/auth";
import { getAuth } from "@/lib/auth";
import { useMemo } from "react";

interface ProvidersProps {
  children: React.ReactNode;
}

export function Providers({ children }: ProvidersProps) {
  // Create auth instance only on client-side
  const auth = useMemo(() => {
    if (typeof window === "undefined") {
      return null;
    }
    try {
      return getAuth();
    } catch (error) {
      console.error("Failed to initialize auth:", error);
      return null;
    }
  }, []);

  // If auth isn't available (missing env vars), render children without auth
  if (!auth) {
    return <>{children}</>;
  }

  return <AuthProvider adapter={auth}>{children}</AuthProvider>;
}
