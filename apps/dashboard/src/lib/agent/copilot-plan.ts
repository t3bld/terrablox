import "server-only";

/**
 * What the signed-in user's Copilot licence currently allows.
 *
 * GitHub documents no endpoint for a person's own Copilot quota — this is the
 * one the editors themselves call. Being undocumented it can change without
 * notice, so every field is treated as optional and anything unexpected
 * degrades to "we don't know" rather than to an error: the numbers are
 * informational, and the agent works with or without them.
 */

const ENTITLEMENT_URL = "https://api.github.com/copilot_internal/user";

export interface CopilotQuota {
  unlimited: boolean;
  entitlement: number;
  used: number;
  remaining: number;
  percentRemaining: number;
  overagePermitted: boolean;
}

export interface CopilotPlan {
  plan: string | null;
  organizations: string[];
  resetsOn: string | null;
  /** Premium requests are the only metered budget; chat and completions are not. */
  premium: CopilotQuota | null;
}

interface RawQuota {
  unlimited?: boolean;
  entitlement?: number;
  credits_used?: number;
  remaining?: number;
  percent_remaining?: number;
  overage_permitted?: boolean;
}

interface RawEntitlement {
  copilot_plan?: string;
  organization_login_list?: string[];
  quota_reset_date?: string;
  quota_snapshots?: { premium_interactions?: RawQuota };
}

export async function fetchCopilotPlan(
  token: string,
): Promise<CopilotPlan | null> {
  const res = await fetch(ENTITLEMENT_URL, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    cache: "no-store",
  });

  // 403 here means the token is not entitled, which the card already says in
  // its own words after the test request. Nothing to add.
  if (!res.ok) {
    return null;
  }

  const body = (await res.json()) as RawEntitlement;

  return {
    plan: body.copilot_plan ?? null,
    organizations: body.organization_login_list ?? [],
    resetsOn: body.quota_reset_date ?? null,
    premium: toQuota(body.quota_snapshots?.premium_interactions),
  };
}

function toQuota(raw: RawQuota | undefined): CopilotQuota | null {
  if (!raw) {
    return null;
  }

  return {
    unlimited: raw.unlimited ?? false,
    entitlement: raw.entitlement ?? 0,
    used: raw.credits_used ?? 0,
    remaining: raw.remaining ?? 0,
    percentRemaining: raw.percent_remaining ?? 0,
    overagePermitted: raw.overage_permitted ?? false,
  };
}
