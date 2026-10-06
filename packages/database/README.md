# @terrablox/database

The Prisma schema, the migrations, and a single shared client instance. This
package owns the shape of the data; everything else in the repo reads it from
here rather than describing it again.

## Two ways in, and the difference matters

```ts
// Model types. Erased at compile time, so they are safe in a client component.
import type { Project } from "@terrablox/database";

// The live client. Server-only, and it installs connection shutdown handlers.
import { prisma } from "@/lib/database";
```

Importing the client straight from this package works, but silently skips the
`SIGINT`/`SIGTERM` handling in `apps/dashboard/src/lib/database.ts`. Types come
from the package, the client comes from the app wrapper.
`apps/dashboard/src/lib/module-library/import-from-git.ts` does both in one file and is
the reference case.

The client is a singleton pinned to `globalThis`, because Next's dev server
re-evaluates modules on every hot reload and a fresh `PrismaClient` per reload
exhausts the connection pool within a few edits.

## Migrations

`prisma/migrations/` is the source of truth for deployment — the production image
runs `prisma migrate deploy` as a one-off container before the app starts (see
`docker-compose.yml`). Every table the schema declares must therefore have a
migration that creates it; `prisma db push` is for local experiments only, and a
schema change that never became a migration is a change that will not exist in
production.

## Scripts

Run these from the repo root, and only from there:

| Command | What it does |
| --- | --- |
| `pnpm db:push` | Sync the schema to a local database without a migration |
| `pnpm db:migrate` | Apply pending migrations (`migrate deploy`) |
| `pnpm db:migrate:dev` | Create a migration from schema changes and apply it |
| `pnpm db:reset` | Drop and rebuild from migrations — **destroys local data** |
| `pnpm db:generate` | Regenerate the Prisma client |
| `pnpm db:studio` | Open Prisma Studio |

They live in the root `package.json` rather than in this one, and that is the
whole trick behind this package having no `.env` of its own. The Prisma CLI reads
`.env` from its working directory, so a script that runs here would only ever see
a file sitting here — which is exactly why `DATABASE_URL` used to be duplicated
between `packages/database/.env` and the app's own env file. Run from the root and
the CLI finds the one root `.env`; `"prisma": { "schema": ... }` in the root
manifest is what lets it still find this schema.

The one script left in this package is `postinstall`, which runs `prisma generate`
with an inline placeholder `DATABASE_URL`. Generating a client never opens a
connection, and the placeholder means a bare `git clone && pnpm install` works
before any configuration exists.
