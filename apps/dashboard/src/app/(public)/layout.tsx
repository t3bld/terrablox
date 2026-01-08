"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { useAuth } from "@terrablox/auth";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isLoading, isAuthenticated } = useAuth();

  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated) return;

    const next = searchParams?.get("next");
    router.replace(next || "/");
  }, [isLoading, isAuthenticated, router, searchParams]);

  return <>{children}</>;
}

