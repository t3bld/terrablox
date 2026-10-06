# @terrablox/auth

The **browser half** of authentication: a provider, three hooks, and an adapter
interface with one implementation on top of Better Auth's React client.

This package deliberately stops at the network boundary. It knows how to ask a
server about the current session; it does not know how sessions are issued, which
OAuth scopes are requested, or which routes require one.

## Where the other half lives

The server half is in the dashboard, because every part of it is bound to that
app: it needs the Prisma client, Next's cookie plugin, the app's environment
variables, and a Next route handler to sit behind.

| Concern | File |
| --- | --- |
| `betterAuth()` config, GitHub provider, OAuth scopes, token encryption | `apps/dashboard/src/lib/auth/server.ts` |
| Reading the session and the user's GitHub token server-side | `apps/dashboard/src/lib/auth/server-helpers.ts` |
| Which paths need a session | `apps/dashboard/src/lib/auth/auth-routing.ts` |
| Cookie check on every request | `apps/dashboard/src/middleware.ts` |
| The endpoints themselves | `apps/dashboard/src/app/api/auth/[...all]/route.ts` |

If you are looking for *why sign-in behaves the way it does* — GitHub only, no
email and password, which scopes and what they are for — that reasoning is in
`server.ts`, not here.

## Usage

```tsx
// Once, at the root of the app.
import { AuthProvider } from "@terrablox/auth";
import { BetterAuthAdapter } from "@terrablox/auth/adapters/better-auth";

<AuthProvider adapter={new BetterAuthAdapter({ baseURL })}>
  {children}
</AuthProvider>;
```

```tsx
// Anywhere below it.
import { useAuth, useSession, useUser } from "@terrablox/auth/hooks";
```

## Adding a provider

`AuthAdapter` in `src/types.ts` is an abstract class rather than an interface so
an implementation cannot silently forget a method. Extend it, and the provider
stays a detail of one file — `AuthProvider` and every hook are written against
the abstraction, not against Better Auth.
