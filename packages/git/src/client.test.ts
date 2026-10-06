import { afterEach, describe, expect, it, vi } from "vitest";

import { GithubRequestError, githubRequest } from "./client";

/**
 * The one transport, and the diagnosis it adds.
 *
 * `fetch` is stubbed rather than hit: what is worth pinning down is not GitHub's
 * behaviour but ours — that every call goes to the same host with the same headers, and
 * that a failure carries a message somebody can act on.
 *
 * The scope note is the part with history behind it. GitHub answers a permission it does
 * not like with `404 Not Found` and says nothing about permissions, so committing a
 * workflow file with a token that lacked the `workflow` scope failed with a bare 404 from
 * `POST /git/trees` — which reads as "the repository is gone". The headers were on the
 * response the whole time; the old client collected them into a field nobody read.
 */

const respond = (
  status: number,
  body = "",
  headers: Record<string, string> = {},
) =>
  vi.fn().mockResolvedValue(
    new Response(body, {
      status,
      statusText: status === 404 ? "Not Found" : "Error",
      headers,
    }),
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("githubRequest", () => {
  it("sends the token, the media type and the pinned API version", () => {
    const fetchMock = respond(200, "{}");
    vi.stubGlobal("fetch", fetchMock);

    void githubRequest("tok", "/user");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/user");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer tok",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    });
  });

  it("takes a path, so no call site can point somewhere else", () => {
    // Half of why the two clients were merged: the other one took a full URL and each
    // caller assembled `https://api.github.com/...` itself.
    const fetchMock = respond(200, "{}");
    vi.stubGlobal("fetch", fetchMock);

    void githubRequest("tok", "/repos/o/r/git/trees");

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repos/o/r/git/trees",
    );
  });

  it("never caches, because the repository is the source of truth", () => {
    const fetchMock = respond(200, "{}");
    vi.stubGlobal("fetch", fetchMock);

    void githubRequest("tok", "/user");

    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).cache).toBe(
      "no-store",
    );
  });

  it("lets the caller add headers without losing the defaults", () => {
    const fetchMock = respond(200, "{}");
    vi.stubGlobal("fetch", fetchMock);

    void githubRequest("tok", "/user/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject(
      {
        Authorization: "Bearer tok",
        "Content-Type": "application/json",
      },
    );
  });

  describe("on failure", () => {
    it("throws one error type, carrying the status", async () => {
      vi.stubGlobal("fetch", respond(404, "Not Found"));

      await expect(githubRequest("tok", "/repos/o/r")).rejects.toThrow(
        GithubRequestError,
      );
      await expect(githubRequest("tok", "/repos/o/r")).rejects.toMatchObject({
        status: 404,
      });
    });

    it("quotes the body, so the provider's own words survive", async () => {
      vi.stubGlobal("fetch", respond(422, "Must supply a valid tree.mode"));

      await expect(
        githubRequest("tok", "/repos/o/r/git/trees"),
      ).rejects.toThrow(/Must supply a valid tree\.mode/);
    });

    it("names the scope the token is missing", async () => {
      // Exactly the workflow-file case, as GitHub actually answers it.
      vi.stubGlobal(
        "fetch",
        respond(404, '{"message":"Not Found"}', {
          "x-oauth-scopes": "read:org, repo, user:email",
          "x-accepted-oauth-scopes": "workflow",
        }),
      );

      await expect(
        githubRequest("tok", "/repos/o/r/git/trees", { method: "POST" }),
      ).rejects.toThrow(/missing the workflow scope/);
    });

    it("keeps the scopes on the error, for a caller that wants to explain more", async () => {
      vi.stubGlobal(
        "fetch",
        respond(404, "", {
          "x-oauth-scopes": "repo",
          "x-accepted-oauth-scopes": "workflow",
        }),
      );

      await expect(githubRequest("tok", "/x")).rejects.toMatchObject({
        scopes: { granted: "repo", required: "workflow" },
      });
    });

    it("stays quiet about scopes when the token already has what was asked", async () => {
      // Otherwise every ordinary 404 — a missing file, a bad ref — would come with a
      // paragraph about permissions that were fine.
      vi.stubGlobal(
        "fetch",
        respond(404, "Not Found", {
          "x-oauth-scopes": "repo, workflow",
          "x-accepted-oauth-scopes": "repo",
        }),
      );

      await expect(githubRequest("tok", "/repos/o/r")).rejects.toThrow(
        /^(?!.*scope).*$/s,
      );
    });

    it("stays quiet when GitHub named no requirement", async () => {
      vi.stubGlobal("fetch", respond(500, "boom"));

      await expect(githubRequest("tok", "/x")).rejects.toThrow(
        /^(?!.*scope).*$/s,
      );
    });

    it("reports the status even when the body cannot be read", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 502,
          statusText: "Bad Gateway",
          headers: new Headers(),
          text: () => Promise.reject(new Error("stream closed")),
        }),
      );

      await expect(githubRequest("tok", "/x")).rejects.toThrow(
        /502 Bad Gateway/,
      );
    });
  });
});
