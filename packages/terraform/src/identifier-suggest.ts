/**
 * "Did you mean" for Terraform identifiers.
 *
 * Lifted out of the dashboard's graph projection once a second caller appeared: the MCP
 * server checks a proposed module call against the module's real interface, and gets the
 * same class of near miss for the same reason — an agent naming an input from memory.
 * A package may not import from an app, so a shared utility has to live at this level.
 */

/**
 * The closest of a set of names, when one is close enough to be worth offering.
 *
 * The point of a "did you mean" is that a wrong name costs the turn one call
 * instead of a wrong commit. That only works if the suggestion is usually right,
 * so the threshold is strict: a third of the name may differ, no more. Below that
 * the refusal simply says the name is unknown, which is still actionable.
 */
export function closestName(
  wanted: string,
  candidates: readonly string[],
): string | null {
  const needle = wanted.trim().toLowerCase();
  if (!needle) return null;

  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const distance = editDistance(needle, candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }

  const allowed = Math.max(1, Math.floor(needle.length / 3));
  return best !== null && bestDistance <= allowed ? best : null;
}

/** Levenshtein, two rows at a time; the inputs here are identifier-sized. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution =
        (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(
        substitution,
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
      );
    }
    previous = current;
  }

  return previous[b.length] as number;
}
