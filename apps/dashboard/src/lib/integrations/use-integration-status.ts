"use client";

import { useCallback, useEffect, useState } from "react";

export interface IntegrationStatus {
  aws: { connected: boolean; verified: boolean };
  infracost: { connected: boolean };
}

/**
 * Which integrations the signed-in user has connected.
 *
 * Screens gate on this, so an unknown answer is never treated as "connected":
 * a failed request leaves the status null and the caller keeps waiting rather
 * than opening a tab that cannot work.
 */
export function useIntegrationStatus() {
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/integrations/status");
      if (!response.ok) return;
      setStatus((await response.json()) as IntegrationStatus);
    } catch {
      // The gate stays closed and offers a retry; nothing else to report.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { status, loading, refresh };
}
