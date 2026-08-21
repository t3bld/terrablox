"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Only what is genuinely per user.
 *
 * AWS used to be here too, and that was the bug: "this user has a connection"
 * unlocked a project that had no account of its own. AWS is now asked per project
 * through `/api/projects/[projectId]/aws`.
 */
export interface IntegrationStatus {
  infracost: { connected: boolean };
  /**
   * GitHub, which is not optional: repositories, projects and the agent's
   * Copilot seat all come through it, so a disconnected account is not a missing
   * feature but a tool that cannot do anything.
   */
  github: { configured: boolean; connected: boolean };
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
