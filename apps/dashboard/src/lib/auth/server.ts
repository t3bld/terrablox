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

  emailAndPassword: {
    enabled: true,
    // No SMTP in a local setup: print the reset link to the server console.
    sendResetPassword: async ({ user, url }) => {
      console.log(`[auth] Password reset link for ${user.email}: ${url}`);
    },
  },

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
      // There is no SMTP server in this setup, so `emailVerified` never turns
      // true for email/password users. Left at its default, that would block
      // every attempt to link a GitHub account to such a user.
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
