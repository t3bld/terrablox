<p align="center">
	<h1 align="center"><b>TerraBlox</b></h1>
<p align="center">
    Open Source Terraform Assistant and Infrastructure Designer
    <br />
    <br />
    <a href="https://terrablox.de">Website</a>
    ·
    <a href="https://github.com/t3bld/terrablox/issues">Issues</a>
    ·
    <a href="https://github.com/ttt/issues">Documentation</a>
    ·
    <a href="https://github.com/t3bld/terrablox?tab=AGPL-3.0-1-ov-file">License</a>
    ·
    <a href="https://github.com/t3bld/terrablox">Contribute</a>
  </p>
</p>

## ✨ Key Features

- **Terraform Analyzer**: Get a clear understanding of the cloud infrastructure and its dependencies 

## ⚙️ Tech Stack

- [Turborepo](https://turborepo.com/) – Monorepo
- [pnpm](https://pnpm.io/) – Package Manager
- [Next.js](https://nextjs.org/) – React Framework
- [TypeScript](https://www.typescriptlang.org/) – Language
- [TailwindCSS](https://tailwindcss.com/) – Styling
- [shadcn/ui](https://ui.shadcn.com/) - UI Components
- [Prisma](https://prisma.io/) - ORM
- [PostgreSQL](https://www.postgresql.org/) – Database (runs locally via Docker)
- [Better Auth](https://better-auth.com/) – Authentication (self-hosted, same database)

TerraBlox runs **entirely on your own machine** — there is no hosting provider, no managed
database and no external auth service. Everything (app, database, authentication) runs
locally via `pnpm dev` and Docker. For all service integrations you can implement your own
adapters or use the provided default ones.

## 🚀 Quick Start

You need [Docker](https://docs.docker.com/get-docker/), [pnpm](https://pnpm.io/) and Node 18+.

```bash
pnpm quickstart
```

That single command checks your prerequisites, creates both `.env` files (including a
freshly generated `BETTER_AUTH_SECRET`), installs dependencies, starts PostgreSQL in
Docker, applies the migrations and launches the dev servers.

- Dashboard: http://localhost:3001

It is safe to re-run at any time — existing `.env` files and database contents are never
overwritten. Use `pnpm quickstart --no-dev` to set everything up without starting the dev
server. On Windows, run it from WSL or Git Bash.

<details>
<summary>Manual setup (what the script does)</summary>

```bash
# 1. Start the local PostgreSQL database (host port 5433)
docker compose up -d

# 2. Install dependencies
pnpm install

# 3. Create your env files
cp apps/dashboard/.env.example apps/dashboard/.env
cp packages/database/.env.example packages/database/.env

# 4. Generate a session secret and put it in BETTER_AUTH_SECRET (apps/dashboard/.env)
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"

# 5. Create the database schema
pnpm db:migrate

# 6. Start the development servers
pnpm dev
```

</details>

### Environment files

There are exactly two, and they are not copies of each other:

| File | Read by | Contains |
| --- | --- | --- |
| `apps/dashboard/.env` | the Next.js app | everything: DB URL, auth secret, GitHub credentials |
| `packages/database/.env` | the Prisma CLI only | `DATABASE_URL` + `DIRECT_URL`, nothing else |

The second file exists because the Prisma CLI resolves environment variables relative to
`schema.prisma` and therefore cannot read the app's file. Secrets are deliberately *not*
duplicated into it. Change configuration in `apps/dashboard/.env`; only touch
`packages/database/.env` when the database URL itself changes — `pnpm quickstart` warns
when the two drift apart.

Per-application env files are [the layout Turborepo
recommends](https://turborepo.dev/docs/crafting-your-repository/using-environment-variables#use-env-files-in-application-packages);
a single repo-root `.env` is explicitly discouraged.

### Database

Postgres runs in Docker (see `docker-compose.yml`) and is published on host port
**5433** so it does not clash with a system-wide Postgres on 5432. Data lives in the
named volume `terrablox-pgdata`.

```bash
pnpm db:up                  # start   (alias for docker compose up -d)
pnpm db:down                # stop, keeps data (alias for docker compose down)
docker compose down -v      # stop and wipe all data
pnpm db:migrate             # apply migrations
pnpm db:push                # sync the Prisma schema without a migration (prototyping)
pnpm db:reset               # drop everything and re-apply migrations
pnpm db:studio              # browse the data
```

### Authentication

Auth is handled by [Better Auth](https://better-auth.com/) running in-process inside the
Next.js app (`/api/auth/[...all]`). Users, sessions and OAuth accounts are stored in the
same PostgreSQL database — there is no external auth service.

Email/password sign-up works out of the box. Since no SMTP server is configured for local
development, **password reset links are printed to the server console** instead of being
emailed.

Because emails can never be verified in this setup, account linking is configured explicitly
in `apps/dashboard/src/lib/auth/server.ts`:

- GitHub is a **trusted provider** — GitHub verifies the email addresses it returns, so it is
  accepted as proof of identity. Signing in with GitHub attaches to an existing account with
  the same email instead of failing.
- **Different emails are allowed when linking.** A work login address and a personal GitHub
  address are rarely identical. This applies only when an already signed-in user deliberately
  links an account; sign-in still matches strictly on email.

### GitHub integration (optional)

Required only for importing Terraform modules from private GitHub repositories.
If left unconfigured the app still runs — only the GitHub import is disabled.

Module code stays in Git; the database only holds metadata. Every module page
therefore reads from the repository at view time, which is why *who* the server
reads as matters:

| | Reads repos as | Who sees a module |
| --- | --- | --- |
| **GitHub App** (recommended for orgs) | the App installation | everyone, identically |
| **OAuth App** | the signed-in user | only users with personal access |

#### GitHub App (recommended)

1. Create the App at
   `https://github.com/organizations/<YOUR-ORG>/settings/apps/new`
   (personal use: [github.com/settings/apps/new](https://github.com/settings/apps/new)).
   - **Homepage URL:** `http://localhost:3001`
   - **Callback URL:** `http://localhost:3001/api/auth/callback/github`
   - Enable **Request user authorization (OAuth) during installation**
   - Disable **Webhook → Active** (not used)
   - **Repository permissions:** `Contents: Read-only`, `Metadata: Read-only`
2. On the App page: copy the **Client ID** and generate a **client secret**, note
   the **App ID**, and click **Generate a private key** (downloads a `.pem`).
3. **Install** the App into the organisation and select the repositories it may read.
4. Fill `apps/dashboard/.env`:
   ```
   GITHUB_CLIENT_ID=...
   GITHUB_CLIENT_SECRET=...
   GITHUB_APP_ID=123456
   GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n"
   ```
   Note that the **Client ID** and the **App ID** are two different values; both
   are on the App's settings page.
   Newlines may be escaped as `\n`, or the whole `.pem` may be base64-encoded.
   Only set `GITHUB_APP_INSTALLATION_ID` if the App is installed in more than one
   account.
5. Restart `pnpm dev`.

Signing in with GitHub then only establishes *identity*; repository reads use the
installation token, so no user ever needs the broad `repo` scope.

> ⚠️ If your organisation enforces SAML SSO, members still need an active SAML
> session in GitHub to authorize the App for org resources.

#### OAuth App (single user / quick test)

1. Create an OAuth App at
   [github.com/settings/developers](https://github.com/settings/developers) with the
   same homepage and callback URL as above.
2. Put the credentials into `apps/dashboard/.env`:
   ```
   GITHUB_CLIENT_ID=...
   GITHUB_CLIENT_SECRET=...
   ```
3. Restart `pnpm dev`. Each user grants the `repo` scope on first link.

## 🤖 MCP (AI Assistant Integration)

This repo ships with a `.mcp.json` configuration so AI assistants (GitHub Copilot,
Cursor, Claude, etc.) can work directly with your **GitHub** repositories.

### One-time setup

1. Copy the example config (tokens are filled in here, and it is git-ignored):
   ```bash
   cp .mcp.json.example .mcp.json
   ```
2. Point your MCP-capable client at the project's `.mcp.json`:
   - **JetBrains (GitHub Copilot plugin):** Settings → Tools → GitHub Copilot → Model
     Context Protocol → import/point to `.mcp.json`.
   - **VS Code / Cursor / Claude Desktop:** load or copy the contents of `.mcp.json`.
3. Restart your editor/assistant after editing tokens.

### GitHub server

Uses GitHub's **remote hosted** MCP server at `https://api.githubcopilot.com/mcp/` — no
Docker, no local install. It is locked down to a **single repository** —
[`t3bld/terrablox`](https://github.com/t3bld/terrablox) — via a fine-grained token.

1. Create a **fine-grained** GitHub personal access token at
   [github.com/settings/personal-access-tokens](https://github.com/settings/personal-access-tokens).
   - Under **Repository access**, select **Only select repositories** →
     `t3bld/terrablox`. This is what restricts the server to that one repo.
   - Grant only read permissions you need (e.g. Contents: Read-only, Issues: Read-only,
     Pull requests: Read-only).
2. In `.mcp.json`, set the `Authorization` header to `Bearer <your-token>`.

> ℹ️ Repository scope is enforced by the fine-grained token. Do **not** use a classic or
> org-wide token if you want to keep access limited to `t3bld/terrablox`.

> ℹ️ Prefer signing in instead of pasting a token? The same remote server supports OAuth
> (browser popup) if you omit the `Authorization` header — but OAuth authorizes your
> whole account, so it will **not** keep access limited to a single repo. See
> `.mcp.oauth.json.example`.

If you'd like to contribute, please fork the repository and make any changes you'd like. Pull requests are warmly welcome.



