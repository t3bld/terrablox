"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { useAuth } from "@terrablox/auth";

export default function PublicLayout({
  children,
}: { children: React.ReactNode }) {
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
