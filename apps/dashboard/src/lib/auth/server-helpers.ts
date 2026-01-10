import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Retrieves the Git provider token from the user's session (server-side).
 *
 * This is a Supabase-specific implementation. To support other auth providers,
 * you would create a different version of this file and inject it.
 */
export async function getProviderTokenForRequest(
  req: Request,
  provider: string,
): Promise<string | null> {
  const cookieStore = cookies();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
      },
    },
  );

  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (session?.provider_token && provider === "github") {
    return session.provider_token;
  }

  return null;
}
