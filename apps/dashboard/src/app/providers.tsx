"use client";

import { AuthProvider } from "@terrablox/auth";
import { SupabaseAuthAdapter } from "@terrablox/auth/adapters/supabase";
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
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

      if (!supabaseUrl || !supabaseAnonKey) {
        throw new Error("Missing Supabase environment variables.");
      }

      return new SupabaseAuthAdapter({
        url: supabaseUrl,
        anonKey: supabaseAnonKey,
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
