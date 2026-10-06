import { beforeEach, describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/route-error";

import { __resetRateLimits, enforceRateLimit, userRateKey } from "./rate-limit";

describe("enforceRateLimit", () => {
  beforeEach(() => {
    __resetRateLimits();
  });

  const limit = { max: 3, windowSeconds: 60 };

  it("allows calls up to the budget", () => {
    for (let i = 0; i < 3; i++) {
      expect(() => enforceRateLimit("k", limit)).not.toThrow();
    }
  });

  it("throws a 429 once the budget is spent", () => {
    for (let i = 0; i < 3; i++) enforceRateLimit("k", limit);

    try {
      enforceRateLimit("k", limit);
      expect.unreachable("should have been rate limited");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(429);
      // The message names the wait, since the budget is not actionable.
      expect((error as ApiError).message).toMatch(/Try again in \d+ second/);
    }
  });

  it("keeps budgets separate per key", () => {
    for (let i = 0; i < 3; i++) enforceRateLimit("a", limit);

    // Exhausting one caller must not affect another, which is what makes the
    // per-user key the right one — an IP key would share a budget across a NAT.
    expect(() => enforceRateLimit("b", limit)).not.toThrow();
  });

  it("keeps scopes separate for the same user", () => {
    const agent = userRateKey("u1", "agent.turn");
    const write = userRateKey("u1", "project.write");

    for (let i = 0; i < 3; i++) enforceRateLimit(agent, limit);

    // Hitting the agent ceiling must not lock the user out of reading their
    // project list.
    expect(() => enforceRateLimit(write, limit)).not.toThrow();
  });

  it("forgets calls once the window has passed", () => {
    const shortLimit = { max: 1, windowSeconds: 0 };

    enforceRateLimit("k", shortLimit);
    // A zero-length window means every previous hit is already outside it.
    expect(() => enforceRateLimit("k", shortLimit)).not.toThrow();
  });
});
