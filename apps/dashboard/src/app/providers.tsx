"use client";

import { AuthProvider } from "@terrablox/auth";
import { BetterAuthAdapter } from "@terrablox/auth/adapters/better-auth";
import type React from "react";
import { useMemo } from "react";

interface ProvidersProps {
  children: React.ReactNode;
}

export function Providers({ children }: ProvidersProps) {
  const auth = useMemo(() => {
    // Create auth only on client-side
    if (typeof window === "undefined") {
      return null;
    }

    try {
      return new BetterAuthAdapter({
        baseURL: process.env.NEXT_PUBLIC_APP_URL ?? window.location.origin,
      });
    } catch {
      return null;
    }
  }, []);

  if (!auth) {
    return <>{children}</>;
  }

  return <AuthProvider adapter={auth}>{children}</AuthProvider>;
}
