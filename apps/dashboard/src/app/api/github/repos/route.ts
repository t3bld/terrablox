import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type GithubOwner = {
  login: string;
};

type GithubRepo = {
  id: number;
  name: string;
  description: string | null;
  private: boolean;
  html_url: string;
  owner: GithubOwner;
};

export async function GET() {
  const cookieStore = cookies();

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return NextResponse.json(
      { error: "Missing Supabase environment variables." },
      { status: 500 },
    );
  }

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      get(name: string) {
        return cookieStore.get(name)?.value;
      },
    },
  });

  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const providerToken = session.provider_token;

  if (!providerToken) {
    return NextResponse.json(
      {
        error:
          "GitHub provider token not found. Please re-link your GitHub account.",
      },
      { status: 400 },
    );
  }

  try {
    const allRepos: GithubRepo[] = [];
    let page = 1;
    let hasNextPage = true;

    const baseUrl =
      "https://api.github.com/user/repos?affiliation=owner,organization_member&visibility=all&per_page=100";

    while (hasNextPage) {
      const response = await fetch(`${baseUrl}&page=${page}`, {
        headers: {
          Authorization: `Bearer ${providerToken}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });

      if (!response.ok) {
        let message = response.statusText;
        try {
          const errorData = (await response.json()) as { message?: string };
          message = errorData?.message ?? message;
        } catch {
          // ignore
        }

        const scopes = response.headers.get("x-oauth-scopes") ?? undefined;

        return NextResponse.json(
          {
            error: `Failed to fetch from GitHub: ${message}`,
            status: response.status,
            scopes,
          },
          { status: response.status },
        );
      }

      const data = (await response.json()) as GithubRepo[];
      allRepos.push(...data);

      const linkHeader = response.headers.get("Link");
      if (linkHeader?.includes('rel="next"')) {
        page++;
      } else {
        hasNextPage = false;
      }
    }

    return NextResponse.json(allRepos);
  } catch {
    return NextResponse.json(
      { error: "An unexpected error occurred." },
      { status: 500 },
    );
  }
}
