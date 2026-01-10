import { createAuth } from "@terrablox/auth";
import {AuthAdapter} from "@terrablox/auth/types";

let authAdapter: AuthAdapter | null = null;

export function getAuth(): AuthAdapter {
  if (authAdapter) {
    return authAdapter;
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("Missing Supabase environment variables.");
  }

  authAdapter = createAuth({
    type: "supabase",
    config: {
      url: supabaseUrl,
      anonKey: supabaseAnonKey,
    },
  });

  return authAdapter;
}
