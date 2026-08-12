/**
 * Node positions of a module's connection graph, keyed by Terraform address.
 *
 * Kept free of server-only imports so the API route and the client component
 * share one definition of what a valid layout is.
 */
/**
 * A single node's coordinates.
 *
 * Declared as a type alias rather than an interface on purpose: only aliases
 * get an implicit index signature, which Prisma's `InputJsonValue` requires.
 */
export type GraphNodePosition = {
  x: number;
  y: number;
};

export type GraphLayout = Record<string, GraphNodePosition>;

/** Guards against unbounded payloads; far above any realistic module. */
export const maxGraphLayoutNodes = 2000;

/** Keeps a stray Infinity or a runaway drag out of the database. */
const maxCoordinate = 1_000_000;

function isFiniteCoordinate(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= maxCoordinate
  );
}

/**
 * Accepts only well-formed `{ address: { x, y } }` entries and silently drops
 * everything else. Positions arrive from the client and are echoed back to it,
 * so malformed data must never reach the database.
 */
export function parseGraphLayout(value: unknown): GraphLayout {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  const layout: GraphLayout = {};
  let count = 0;

  for (const [address, position] of Object.entries(value)) {
    if (count >= maxGraphLayoutNodes) break;
    if (!address || typeof position !== "object" || position === null) continue;

    const { x, y } = position as Record<string, unknown>;
    if (!isFiniteCoordinate(x) || !isFiniteCoordinate(y)) continue;

    layout[address] = { x, y };
    count += 1;
  }

  return layout;
}

/**
 * Restricts a stored layout to addresses the graph still contains. A re-import
 * or a changed filter can retire an address; keeping it would grow the row
 * forever and could resurrect a node that no longer exists.
 */
export function pruneGraphLayout(
  layout: GraphLayout,
  knownAddresses: Iterable<string>,
): GraphLayout {
  const known = new Set(knownAddresses);
  const pruned: GraphLayout = {};

  for (const [address, position] of Object.entries(layout)) {
    if (known.has(address)) pruned[address] = position;
  }

  return pruned;
}

/** True when both layouts hold the same addresses at the same coordinates. */
export function graphLayoutsEqual(a: GraphLayout, b: GraphLayout): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;

  return aKeys.every((key) => {
    const left = a[key];
    const right = b[key];
    return right !== undefined && left?.x === right.x && left?.y === right.y;
  });
}
