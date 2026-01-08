import { createServerClient, type CookieOptions } from "@supabase/ssr";
import type { NextRequest, NextResponse } from "next/server";

import type { ServerAuth } from "../server-auth";

/**
 * Supabase implementation of the `ServerAuth` contract.
 *
 * This file is OPTIONAL: teams can replace it with their own implementation
 * (Auth0, Clerk, custom JWT cookies, etc.) without changing middleware.
 */
export function createSupabaseServerAuth(): ServerAuth {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("Missing Supabase environment variables.");
  }

  return {
    isAuthenticated: async (req: NextRequest, res: NextResponse) => {
      const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
        cookies: {
          getAll() {
            return req.cookies.getAll();
          },
          setAll(
            cookies: Array<{
              name: string;
              value: string;
              options: CookieOptions;
            }>,
          ) {
            for (const { name, value, options } of cookies) {
              res.cookies.set(name, value, options);
            }
          },
        },
      });

      const {
        data: { user },
      } = await supabase.auth.getUser();

      return !!user;
    },
  };
}

