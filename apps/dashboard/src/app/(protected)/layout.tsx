"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

import { useAuth } from "@terrablox/auth";
import { Skeleton } from "@terrablox/ui/skeleton";

export default function ProtectedAppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { isLoading, isAuthenticated } = useAuth();

  useEffect(() => {
    if (isLoading) return;
    if (isAuthenticated) return;

    const next = pathname && pathname !== "/" ? `?next=${encodeURIComponent(pathname)}` : "";
    router.replace(`/login${next}`);
  }, [isLoading, isAuthenticated, router, pathname]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Skeleton className="h-12 w-12 rounded-full" />
          <Skeleton className="h-4 w-32" />
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  return <>{children}</>;
}

