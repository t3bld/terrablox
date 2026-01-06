"use client";

import { AuthProvider } from "@terrablox/auth";
import { getAuth } from "@/lib/auth";
import React, { useMemo } from "react";

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
      return getAuth();
    } catch {
      return null;
    }
  }, []);

  if (!auth) {
    return <>{children}</>;
  }

  return <AuthProvider adapter={auth}>{children}</AuthProvider>;
}
