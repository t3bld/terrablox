import "server-only";

import { database, prisma } from "@terrablox/database";

/**
 * The live Prisma client, for this app.
 *
 * There are two ways to reach the database package, and the difference matters:
 *
 * - **Model types** (`import type { Project } from "@terrablox/database"`) come
 *   straight from the package. Type imports are erased at compile time, so they
 *   are safe in a client component.
 * - **The client itself** (`import { prisma } from "@/lib/database"`) comes from
 *   here. This module is `server-only` and installs the shutdown handlers below,
 *   so importing the client from the package directly would silently opt out of
 *   them.
 *
 * `lib/module-library/import-from-git.ts` is the reference case: types from the package,
 * client from here, in the same file.
 */

if (typeof window !== "undefined") {
  throw new Error("Database client cannot be used on the client side");
}

let isShuttingDown = false;

/**
 * Closes the connection pool when the container is asked to stop.
 *
 * Without this, `docker compose down` leaves Postgres holding sessions that only
 * time out, and a container that restarts often runs into the connection limit
 * long before the timeout clears them.
 */
const gracefulShutdown = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`Received ${signal}, closing database connection...`);
  await database.$disconnect();
  process.exit(0);
};

// Guarded because Next's dev server re-evaluates this module on every hot reload,
// and an unguarded `process.once` per reload eventually trips the max-listeners
// warning.
if (!process.listeners("SIGINT").length) {
  process.once("SIGINT", () => gracefulShutdown("SIGINT"));
  process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));
}

export { database, prisma };
