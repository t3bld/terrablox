"use client";

import { AuthProvider } from "@terrablox/auth";
import { BetterAuthAdapter } from "@terrablox/auth/adapters/better-auth";
import { ToastProvider } from "@terrablox/ui/toast";
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
        // `||`, not `??`: an unset NEXT_PUBLIC_APP_URL is inlined as undefined
        // by Next, but a build arg left empty (the Docker default) inlines as
        // "" - and `"" ?? origin` is "", which would point every auth call at a
        // relative empty base.
        baseURL: process.env.NEXT_PUBLIC_APP_URL || window.location.origin,
      });
    } catch {
      return null;
    }
  }, []);

  // Toasts wrap the auth branch rather than sitting inside it. `auth` is null
  // during the server render and again if the adapter throws, and a provider that
  // existed in only one of those branches would make `useToast` throw in the other
  // — on whichever page happened to render first.
  return (
    <ToastProvider>
      {auth ? <AuthProvider adapter={auth}>{children}</AuthProvider> : children}
    </ToastProvider>
  );
}
