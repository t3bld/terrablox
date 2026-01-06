import { DatabaseAdapter, DatabaseConfig } from "./adapters/base";
import { SupabaseAdapter } from "./adapters/supabase";
import { PostgresAdapter } from "./adapters/postgres";

let databaseInstance: DatabaseAdapter | null = null;

/**
 * Create a database client based on the configured adapter
 */
export async function createDatabaseClient(
  config?: DatabaseConfig,
): Promise<DatabaseAdapter> {
  if (databaseInstance) {
    return databaseInstance;
  }

  const adapter = config?.adapter || process.env.DATABASE_ADAPTER || "supabase";

  let client: DatabaseAdapter;

  switch (adapter) {
    case "supabase":
      client = new SupabaseAdapter();
      break;
    case "postgres":
      client = new PostgresAdapter();
      break;
    case "mysql":
      throw new Error("MySQL adapter not yet implemented");
    case "mongodb":
      throw new Error("MongoDB adapter not yet implemented");
    case "custom":
      throw new Error("Custom adapter must be provided in config");
    default:
      throw new Error(`Unknown database adapter: ${adapter}`);
  }

  await client.connect();
  databaseInstance = client;

  return client;
}

/**
 * Get the existing database client instance
 */
export function getDatabaseClient(): DatabaseAdapter {
  if (!databaseInstance) {
    throw new Error(
      "Database not initialized. Call createDatabaseClient() first.",
    );
  }
  return databaseInstance;
}

/**
 * Disconnect the database client
 */
export async function disconnectDatabase(): Promise<void> {
  if (databaseInstance) {
    await databaseInstance.disconnect();
    databaseInstance = null;
  }
}

export * from "./adapters/base";
export * from "./adapters/supabase";
export * from "./adapters/postgres";
export * from "./schemas";
