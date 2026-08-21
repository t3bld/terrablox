import "server-only";

import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";

import { database } from "@/lib/database";

const githubClientId = process.env.GITHUB_CLIENT_ID;
const githubClientSecret = process.env.GITHUB_CLIENT_SECRET;

export const isGithubConfigured = !!githubClientId && !!githubClientSecret;

const baseURL =
  process.env.BETTER_AUTH_URL ??
  process.env.NEXT_PUBLIC_APP_URL ??
  "http://localhost:3001";

export const auth = betterAuth({
  appName: "TerraBlox",
  baseURL,
  secret: process.env.BETTER_AUTH_SECRET,
  database: prismaAdapter(database, { provider: "postgresql" }),

  // No email and password. Every feature needs a GitHub identity — reading a
  // project's repository, committing the graph, importing modules, running the
  // agent on the user's Copilot seat — so an account without one could sign in
  // and then do nothing. Turning it off here and not only in the UI matters: the
  // endpoints stay reachable otherwise, and a sign-up route nobody links to is
  // still a sign-up route.
  emailAndPassword: { enabled: false },

  socialProviders: isGithubConfigured
    ? {
        github: {
          clientId: githubClientId as string,
          clientSecret: githubClientSecret as string,
          // `repo` + `read:org` are needed to import Terraform modules,
          // `user:email` so GitHub always returns a primary email.
          scope: ["repo", "read:org", "user:email"],
        },
      }
    : undefined,

  account: {
    // GitHub tokens are long-lived, so encrypt them at rest.
    encryptOAuthTokens: true,

    accountLinking: {
      // GitHub verifies the emails it hands out, so we accept it as proof of
      // identity when attaching a GitHub login to an existing account.
      trustedProviders: ["github"],
      // Nothing verifies email here — there is no SMTP server, and no local
      // password to attach one to. Left at its default this would block linking
      // for accounts created before sign-in became GitHub only.
      requireLocalEmailVerified: false,
      // A work login address and a personal GitHub address are rarely the same.
      // Only applies to explicit linking by an already signed-in user, never to
      // sign-in, which still matches strictly on email.
      allowDifferentEmails: true,
    },
  },

  advanced: {
    database: {
      // Keeps ids UUIDs so they line up with the @db.Uuid columns
      // already used by projects, modules and canvas nodes.
      generateId: "uuid",
    },
  },

  // Must stay last so Set-Cookie headers from server actions are applied.
  plugins: [nextCookies()],
});

export type Auth = typeof auth;
