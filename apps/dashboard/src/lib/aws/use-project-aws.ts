"use client";

import { useCallback, useEffect, useState } from "react";

// Type-only, so the `server-only` marker on that module is not tripped: the
// import disappears at compile time and the shape stays defined in one place
// instead of being mirrored here and drifting.
import type { ProjectAwsState } from "@/lib/aws/project-connection";

/**
 * The AWS account one project deploys into, read once per page.
 *
 * Lifted out of the Deploy tab because the answer is now shown in every tab: the
 * account line sits under the tab strip, and the connect card sits inside Deploy
 * and State. Two components asking separately meant two identical requests and,
 * worse, a strip that did not notice the sign-in that had just happened next to
 * it.
 */
export function useProjectAws(projectId: string) {
  const [state, setState] = useState<ProjectAwsState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const read = useCallback(async () => {
    const response = await fetch(`/api/projects/${projectId}/aws`);
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(body?.error ?? "Could not read the AWS connection.");
    }
    return body.aws as ProjectAwsState;
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;

    read()
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Could not read AWS status.",
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [read]);

  const refresh = useCallback(() => {
    setError(null);
    read()
      .then(setState)
      .catch((err: unknown) => {
        setError(
          err instanceof Error ? err.message : "Could not read AWS status.",
        );
      });
  }, [read]);

  /**
   * Records what a PUT or DELETE answered.
   *
   * Both return the same `{ aws }` envelope as the GET, so a write is also a
   * read and there is nothing to re-fetch afterwards.
   */
  const apply = useCallback((next: ProjectAwsState) => {
    setError(null);
    setState(next);
  }, []);

  /**
   * Points this project at an account the user has just signed in to.
   *
   * No region is sent: this says which account the project uses, and the region
   * is the project's own setting — overwriting it with whatever the sign-in
   * defaulted to would silently move where the state lives.
   *
   * Throws, so the caller can report it next to the control that started it.
   */
  const attach = useCallback(
    async (accountId: string) => {
      const response = await fetch(`/api/projects/${projectId}/aws`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error ?? "Could not attach that account.");
      }

      apply(body.aws as ProjectAwsState);
    },
    [projectId, apply],
  );

  return { state, error, refresh, apply, attach };
}
