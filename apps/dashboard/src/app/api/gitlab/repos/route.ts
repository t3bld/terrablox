import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
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

  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const providerToken = session.provider_token;

  if (!providerToken) {
    return NextResponse.json(
      { error: "GitLab provider token not found." },
      { status: 400 },
    );
  }

  try {
    let allRepos: any[] = [];
    let page = 1;
    let hasNextPage = true;

    while (hasNextPage) {
      const response = await fetch(
        `https://gitlab.com/api/v4/projects?owned=true&per_page=100&page=${page}`,
        {
          headers: {
            Authorization: `Bearer ${providerToken}`,
          },
        },
      );

      if (!response.ok) {
        const errorData = await response.json();
        return NextResponse.json(
          { error: `Failed to fetch from GitLab: ${errorData.message}` },
          { status: response.status },
        );
      }

      const data = await response.json();
      allRepos = allRepos.concat(data);

      const linkHeader = response.headers.get("Link");
      if (linkHeader && linkHeader.includes('rel="next"')) {
        page++;
      } else {
        hasNextPage = false;
      }
    }

    return NextResponse.json(allRepos);
  } catch (error) {
    return NextResponse.json(
      { error: "An unexpected error occurred." },
      { status: 500 },
    );
  }
}

