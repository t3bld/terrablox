import { DatabaseAdapter, FindManyParams } from "./base";
import { User, CreateUser, UpdateUser } from "../schemas/user";

/**
 * PostgreSQL Adapter
 * Requires 'pg' package to be installed
 */
export class PostgresAdapter extends DatabaseAdapter {
  private pool: any = null;

  async connect(): Promise<void> {
    const { Pool } = await import("pg");

    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL not found");
    }

    this.pool = new Pool({ connectionString });
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  private getPool() {
    if (!this.pool) {
      throw new Error("Database not connected. Call connect() first.");
    }
    return this.pool;
  }

  users = {
    findMany: async (params?: FindManyParams): Promise<User[]> => {
      const pool = this.getPool();
      const limit = params?.limit || 100;
      const offset = params?.offset || 0;
      const orderBy = params?.orderBy || "created_at";
      const order = params?.order || "desc";

      const query = `
        SELECT * FROM users
        ORDER BY ${orderBy} ${order}
        LIMIT $1 OFFSET $2
      `;

      const result = await pool.query(query, [limit, offset]);
      return result.rows;
    },

    findById: async (id: string): Promise<User | null> => {
      const pool = this.getPool();
      const result = await pool.query("SELECT * FROM users WHERE id = $1", [
        id,
      ]);
      return result.rows[0] || null;
    },

    findByEmail: async (email: string): Promise<User | null> => {
      const pool = this.getPool();
      const result = await pool.query("SELECT * FROM users WHERE email = $1", [
        email,
      ]);
      return result.rows[0] || null;
    },

    create: async (data: CreateUser): Promise<User> => {
      const pool = this.getPool();
      const result = await pool.query(
        "INSERT INTO users (email, name, avatar_url) VALUES ($1, $2, $3) RETURNING *",
        [data.email, data.name, data.avatar_url],
      );
      return result.rows[0];
    },

    update: async (id: string, data: UpdateUser): Promise<User> => {
      const pool = this.getPool();
      const fields = Object.keys(data);
      const values = Object.values(data);
      const setClause = fields
        .map((field, index) => `${field} = $${index + 2}`)
        .join(", ");

      const result = await pool.query(
        `UPDATE users SET ${setClause}, updated_at = NOW() WHERE id = $1 RETURNING *`,
        [id, ...values],
      );
      return result.rows[0];
    },

    delete: async (id: string): Promise<void> => {
      const pool = this.getPool();
      await pool.query("DELETE FROM users WHERE id = $1", [id]);
    },
  };
}
