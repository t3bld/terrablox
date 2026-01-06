import "server-only";

import { database, prisma } from "@terrablox/database";

if (typeof window !== "undefined") {
  throw new Error("Database client cannot be used on the client side");
}

let isShuttingDown = false;

const gracefulShutdown = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`Received ${signal}, closing database connection...`);
  await database.$disconnect();
  process.exit(0);
};

if (!process.listeners("SIGINT").length) {
  process.once("SIGINT", () => gracefulShutdown("SIGINT"));
  process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));
}

export { database, prisma };
