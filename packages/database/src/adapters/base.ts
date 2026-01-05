import { User, CreateUser, UpdateUser } from "../schemas/user";

/**
 * Base database adapter interface
 * All database adapters must implement this interface
 */
export abstract class DatabaseAdapter {
  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;

  // User operations
  abstract users: {
    findMany(params?: FindManyParams): Promise<User[]>;
    findById(id: string): Promise<User | null>;
    findByEmail(email: string): Promise<User | null>;
    create(data: CreateUser): Promise<User>;
    update(id: string, data: UpdateUser): Promise<User>;
    delete(id: string): Promise<void>;
  };
}

export interface FindManyParams {
  limit?: number;
  offset?: number;
  orderBy?: string;
  order?: "asc" | "desc";
}

export interface DatabaseConfig {
  adapter: "supabase" | "postgres" | "mysql" | "mongodb" | "custom";
  connectionString?: string;
  options?: Record<string, unknown>;
}

