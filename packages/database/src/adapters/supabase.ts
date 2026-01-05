import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { DatabaseAdapter, FindManyParams } from "./base";
import { User, CreateUser, UpdateUser } from "../schemas/user";

export class SupabaseAdapter extends DatabaseAdapter {
  private client: SupabaseClient | null = null;

  async connect(): Promise<void> {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseKey) {
      throw new Error(
        "Supabase credentials not found. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY"
      );
    }

    this.client = createClient(supabaseUrl, supabaseKey);
  }

  async disconnect(): Promise<void> {
    // Supabase client doesn't require explicit disconnection
    this.client = null;
  }

  private getClient(): SupabaseClient {
    if (!this.client) {
      throw new Error("Database not connected. Call connect() first.");
    }
    return this.client;
  }

  users = {
    findMany: async (params?: FindManyParams): Promise<User[]> => {
      const client = this.getClient();
      let query = client.from("users").select("*");

      if (params?.limit) {
        query = query.limit(params.limit);
      }

      if (params?.offset) {
        query = query.range(params.offset, params.offset + (params.limit || 10) - 1);
      }

      if (params?.orderBy) {
        query = query.order(params.orderBy, {
          ascending: params.order === "asc",
        });
      }

      const { data, error } = await query;

      if (error) throw error;
      return data as User[];
    },

    findById: async (id: string): Promise<User | null> => {
      const client = this.getClient();
      const { data, error } = await client
        .from("users")
        .select("*")
        .eq("id", id)
        .single();

      if (error) {
        if (error.code === "PGRST116") return null;
        throw error;
      }

      return data as User;
    },

    findByEmail: async (email: string): Promise<User | null> => {
      const client = this.getClient();
      const { data, error } = await client
        .from("users")
        .select("*")
        .eq("email", email)
        .single();

      if (error) {
        if (error.code === "PGRST116") return null;
        throw error;
      }

      return data as User;
    },

    create: async (data: CreateUser): Promise<User> => {
      const client = this.getClient();
      const { data: newUser, error } = await client
        .from("users")
        .insert(data)
        .select()
        .single();

      if (error) throw error;
      return newUser as User;
    },

    update: async (id: string, data: UpdateUser): Promise<User> => {
      const client = this.getClient();
      const { data: updatedUser, error } = await client
        .from("users")
        .update(data)
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;
      return updatedUser as User;
    },

    delete: async (id: string): Promise<void> => {
      const client = this.getClient();
      const { error } = await client.from("users").delete().eq("id", id);

      if (error) throw error;
    },
  };
}

