---
title: Quickstart
description: From a fresh clone to a running instance, in one command.
group: Getting started
order: 10
---

## Before you start

| | |
|---|---|
| [Node.js](https://nodejs.org) | 22 or newer |
| [pnpm](https://pnpm.io) | 8 or newer |
| [Docker](https://docs.docker.com/get-docker/) | For PostgreSQL |

Node 22 is a floor rather than a preference. The agent runs on the GitHub Copilot
CLI, which Terrablox starts as a child process using the same Node that runs the
app, and that CLI needs `Promise.withResolvers` — added in Node 22. On Node 20 every
page loads and the first chat message fails.

You also need a **GitHub App** for sign-in and repository access. Either register
your own or ask the owner of the existing Terrablox GitHub App for access and setup
instructions. Quickstart asks for the app's client ID and secret.

## Run it

```bash
git clone https://github.com/t3bld/terrablox.git
cd terrablox
pnpm quickstart
```

Quickstart checks prerequisites, creates the root `.env` if needed, generates a
session secret, asks for GitHub App credentials, installs dependencies, starts
PostgreSQL and applies migrations. It then offers to configure and start the Cost
Service and import the Terrablox module catalogue before starting the development
servers. Both optional steps default to no and are skipped without an interactive
terminal.

It is safe to re-run: existing configuration values and data are preserved unless
you explicitly change the GitHub App slug. Missing values can be added, including
values carried over from legacy `.env` files. Use
`pnpm quickstart --no-dev` to skip starting the development servers; it still offers
the optional setup steps.

The dashboard is then at **http://localhost:3001**.

## GitHub App setup

GitHub sign-in is required — it is the only way in, and the same grant is what lets
the agent read and write your repositories. Without it the app starts and the login
page can do nothing.

It has to be a **GitHub App**. A classic OAuth App will let you sign in and nothing
more: Terrablox asks GitHub which repositories the *installation* was granted, and
those endpoints reject an OAuth token, so every repository picker comes back empty.

Choose one of these paths:

1. **Existing Terrablox app:** Ask the owner or maintainer of
   [github.com/apps/terrablox](https://github.com/apps/terrablox) for access and
   approved setup instructions. Confirm that it supports your instance's callback
   and setup URLs and can be installed on the account or organisation you need.
   Quickstart requires the app's client ID and client secret; obtain and handle any
   credentials through the owner's approved secure process.
2. **Your own app:** Register and configure an app as described below, then enter
   its client ID, secret and slug in quickstart.

Access to an app alone does not grant access to repositories. The app must also be
installed on the relevant account or organisation, with the selected repositories
approved by an authorised owner.

### Registering your own GitHub App

Register one at `https://github.com/settings/apps/new`, or for an organisation at
`https://github.com/organizations/<your-org>/settings/apps/new`.

**Basics**

| Field | Value |
| --- | --- |
| Homepage URL | anything; your own instance's URL is fine |
| Callback URL | `http://localhost:3001/api/auth/callback/github` |
| Setup URL | `http://localhost:3001/api/github/installations/callback` |
| Redirect on update | enabled |
| Request user authorization (OAuth) during installation | **disabled** — see below |
| Webhook → Active | **disabled** — nothing consumes webhooks |
| Where can this be installed | *Only on this account*, unless you run an instance others sign in to |

Neither path is configurable: they are where the app listens. For a deployed instance
use that host instead of `localhost:3001`; you can register up to ten redirect URIs,
so add both.

**Why the two URLs are different, and why OAuth-during-installation is off**

The app has two return paths because signing in and granting repository access are
two different things:

- **Callback URL** is the OAuth redirect. Signing in *starts* in Terrablox, so the
  auth library generates a `state`, remembers it, and checks it when GitHub comes
  back. That is what makes the redirect tamper-proof.
- **Setup URL** is where GitHub returns after an install, a permission change, or a
  request sent to an organisation owner. GitHub starts these, not Terrablox, so
  there is no `state` — and none is needed: nothing is granted by the redirect, it
  only reports what GitHub already did.

Leave *Request user authorization (OAuth) during installation* enabled and GitHub
sends the post-install redirect to the **Callback URL** instead, carrying an
`installation_id` and no `state`. The auth library looks the state up, finds nothing,
and answers:

```
/api/auth/error?error=state_not_found
```

That is a correct answer to the question it was asked, and a dead end for whoever
just granted access — most visibly when requesting the app on an organisation, where
the redirect is the only feedback the flow has. Turning the option off costs nothing:
whoever installs the app is already signed in, so there is no second authorisation to
collect.

Tick **Redirect on update** so a *changed* selection returns the same way rather than
leaving the user on GitHub.

**Permissions**

Every one of these is load-bearing. Grant less and the failure arrives later, in the
middle of a deployment, as a `404` that reads like a deleted repository.

| Permission | Level | Why |
| --- | --- | --- |
| Repository → Metadata | Read | repository details, branches |
| Repository → Contents | Read and write | read Terraform, initialize a completely empty repository, commit the graph |
| Repository → Workflows | Read and write | commits touching `.github/workflows/` are refused without it, *on top of* Contents |
| Repository → Actions | Read and write | start a deployment run and follow it |
| Repository → Variables | Read and write | the pipeline's configuration |

Leave everything else off, including *Administration*, *Secrets* and every account
permission. Terrablox never creates, deletes or reconfigures a repository, and the
pipeline's configuration lives in repository *Variables* because none of it is
secret. Without *Email addresses*, an account that keeps its email private on GitHub
is shown with its GitHub noreply address. In particular **not** *Copilot Chat*: it sounds relevant
because the agent runs on Copilot, but it is the permission for Copilot Extensions,
which receive a user's chat messages. Terrablox calls Copilot rather than being
called by it, and enabling it would only add a data-sharing line to the consent
screen.

There are no scopes to configure. GitHub Apps use permissions instead, and the
`scope` parameter is ignored — which is why the app requests none.

**Afterwards**

You end up with a client ID and a client secret, which `pnpm quickstart` prompts for
and writes into the root `.env`. To add them later, put them in that file as
`GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` and restart the dev server. If you
registered your own app rather than using `github.com/apps/terrablox`, also set
`GITHUB_APP_SLUG` to your app's slug so the in-app links point at it. Quickstart
offers to set or change it after the client credentials are configured.

Then **install** the app on the account whose repositories you want to use. Signing
in and installing are two separate things: signing in identifies you, installing is
what grants access to repositories. Terrablox links to the install page wherever a
repository list is empty, and on the account screen under *Repository access*.

Choose *Only select repositories* — it is supported and recommended. Terrablox does
not create repositories: a project is imported from one that already exists. Create
one on GitHub, add it to the installation's selection, and pick it in *Import
project*. It may be completely empty; Terrablox then creates the initial `README.md`
commit on its default branch. The project is named after the repository. Only
repositories without any `.tf` file are accepted, so the Terraform root is always
the repository root and there is nothing to configure.

## Cost estimates

The project Costs tab runs the open-source Infracost CLI in a private Cost
Service container. It does not create a GitHub workflow, run Terraform, commit a
snapshot or need AWS credentials. The CLI parses the repository's HCL and
Terrablox stores the result against the source commit, so opening the tab again
spends no Infracost run until the code changes or someone explicitly refreshes
prices.

During interactive quickstart, choose the Cost Service setup and provide a personal
or service-account token from Infracost under *Org Settings → API tokens*. The script
generates `COST_SERVICE_TOKEN` if missing, sets the local `COST_SERVICE_URL` if missing,
and builds and starts the service. Existing values are not overwritten. If a
self-hosted pricing endpoint and API key are already configured, no hosted token is
requested.

Alternatively, add these values to the root `.env` yourself:

```bash
COST_SERVICE_TOKEN=<openssl rand -base64 32>
COST_SERVICE_URL=http://127.0.0.1:8090
INFRACOST_CLI_AUTHENTICATION_TOKEN=...
INFRACOST_CLI_CURRENCY=USD
```

For local development, start PostgreSQL and the Cost Service together before the
host-run dashboard:

```bash
pnpm services:up
pnpm dev:dashboard
```

They can also be managed independently with `pnpm db:up`, `pnpm cost:up`,
`pnpm db:down` and `pnpm cost:down`. Production `docker compose up -d --build`
starts the same Cost Service on the private Compose network; its port is not
published. Without the service or an Infracost token, the tab remains available
and classifies recurring, usage-based and no-charge resources; only monetary
estimates are disabled.

A self-hosted pricing API can be used instead of the hosted token:

```bash
INFRACOST_CLI_PRICING_ENDPOINT=https://pricing.example.com
INFRACOST_CLI_PRICING_API_KEY=...
```

## Module libraries

Terrablox keeps *module libraries* in sync: sets of Terraform module repositories that
users build projects from, next to the modules they import themselves. Every module
shows which library it comes from, and the modules page can filter by library.

Library definitions are stored in PostgreSQL and managed under **Admin Settings →
Libraries**. The initial migration creates the Terrablox and Porsche definitions;
subsequent changes take effect without editing `.env` or restarting the dashboard.

| Field | |
| --- | --- |
| `id` | Stable slug stored on imported rows, e.g. `terrablox`. It cannot change later. |
| `name` | Label shown on every module. |
| `scope` | `global` or `user`. It cannot change later. |
| `visible` | Hides the library everywhere without deleting imported rows. |
| `org` | GitHub organisation or user. |
| `prefix`, `topics` | Repository prefix and/or topics, all of which must match. At least one is required. |
| `publicOnly` | Global only: list public repositories only. |
| `submoduleContainer` | Pinned submodule folder, e.g. `modules`. Empty means auto-detect. |
| `pipelineSecret` | Repository secret name generated pipelines use for private modules. |

Every account currently starts with the instance-level `admin` role, so every
signed-in user can configure module libraries. The role check remains in place so
a stricter assignment model can be introduced later without reopening the API.
If an account was manually demoted, an operator can restore access explicitly:

```bash
pnpm db:user:promote --email you@example.com
```

For an existing installation that used a custom environment value, apply the
migration and import that value once before deleting it:

```bash
pnpm db:migrate
pnpm db:module-libraries:import-env
```

The application never reads `TERRABLOX_MODULE_LIBRARIES` at runtime; the command
exists only to preserve an older installation's settings during this upgrade.

There are two kinds:

- **Global** (`scope: global`): one shared copy that every user sees, such as the
  **Terrablox** catalogue. An operator imports it with a token from the shell.
- **Per-user** (`scope: user`): each user's copy is discovered and imported with
  that user's own GitHub token and repository grants.

Interactive quickstart offers to import the Terrablox catalogue after migrations.
It uses `TERRABLOX_SEED_GITHUB_TOKEN`, `GITHUB_TOKEN` or `GH_TOKEN`, then tries
`gh auth token`, and otherwise prompts for a token without saving it. The import
can take a few minutes. It is not part of dashboard or container startup and can
also be run separately:

```bash
GITHUB_TOKEN=$(gh auth token) pnpm db:builtin:sync    # Terrablox only
GITHUB_TOKEN=$(gh auth token) pnpm db:library:sync    # every active global library
pnpm db:library:status                                # rows and visibility per library
```

`db:library:sync` re-imports every ref by default, which also refreshes the
analysis.
- `--changed-only` skips tags that are already imported. The default branch is
  always refreshed.
- `--prune` removes repositories the org no longer lists. Pruning is opt-in, because
  removing a shared module also removes it from every user's canvas.

Archiving or hiding a library keeps its imported rows. Restoring it is therefore
reversible. Changing repository selection invalidates per-user sync state so old
private contents stay hidden until the next successful sync.

## Private module libraries (Porsche)

Next to the Terrablox catalogue, Terrablox offers per-user libraries: the repositories
in one GitHub organisation that carry all of a set of topics. The default is
**Porsche**: repositories in `porsche-code` tagged both `aws` and `cbbac` (archived
repositories are skipped). Each module shows its library as a badge, and the modules
page can filter by library.

These repositories are private, so they are never part of the shared catalogue. Each
user's copy is discovered with that user's own GitHub token when they open the
modules page or the canvas picker. It refreshes at most every 15 minutes, or at once
with *Refresh*. A user who can't read the repositories doesn't get the library and
sees no error. When access is revoked or a topic is removed, the module disappears at
the next sync.

To make the library available:

1. An owner of `porsche-code` installs the Terrablox GitHub App on the organisation
   (`https://github.com/apps/<GITHUB_APP_SLUG>/installations/new`) and adds the
   module repositories to the selection. The app needs no extra permissions.
2. Users need read access to those repositories on GitHub.

If the app is installed but grants no matching repositories, the modules page links
to the installation settings. If it isn't installed and GitHub reveals that you're a
member of the org, the page links to the install page. GitHub only reveals public
memberships to the app. With a private membership you get no hint, so make the
membership public or ask an owner.

A per-user library is created with `scope: user` under **Admin Settings →
Libraries**. Hide or archive it there without deleting anyone's imported rows.

### Pipelines that use Porsche modules

A workflow's `GITHUB_TOKEN` can only read its own repository, so `terraform init`
cannot clone `porsche-code` modules with it. When a project's Terraform calls one, the
generated plan and apply workflows get an extra step before `terraform init`. That
step reads a repository secret and sets an org-scoped git auth header. The deploy
wizard lists the secret under *Private module access*. To create it:

- Create a fine-grained personal access token (or a machine user's token).
  - Resource owner: `porsche-code`.
  - Repository access: only the module repositories.
  - Repository permissions: *Contents: Read-only*.
- Add it in the project repository under *Settings → Secrets and variables →
  Actions* as `TERRABLOX_PORSCHE_MODULES_TOKEN`. The name is
  `TERRABLOX_<ID>_MODULES_TOKEN`, or `pipelineSecret` if the library sets one.

Terrablox never reads or writes secrets. Projects without Porsche modules get
unchanged workflows and need no secret.

## Captured agent turns

Every agent turn that changes a project is recorded whole, as training data for the
harness. The record holds the prompt and the settings it ran under, the project graph
before and after, the trajectory of thoughts and tool calls, the mutations and
decisions, and the commits the turn produced. A later turn backfills the pipeline's
verdict on those commits — whether the resulting Terraform was valid — which is the
label that makes a turn worth learning from.

Not every turn starts from the graph. Three starting states are distinguished:

- **greenfield** — the project was empty; the agent built from nothing.
- **graph** — the agent extended the existing Terraform graph.
- **legacy** — the agent read an external source and migrated from it. The source is
  captured in full: the application-repository files the agent read (as it saw them,
  pinned to a commit) and the MCP calls it made, including the arguments and the result
  each call returned. This is the on-prem or legacy state a migration transforms from,
  which the before/after graph alone cannot show.

Turns that only answer a question commit nothing and are not recorded. The data is
kept unredacted: it may carry account ids, ARNs, bucket names and source code from the
systems it describes, and users are told their projects are used this way.

Export the records as JSONL, one turn per line:

```bash
pnpm transformations:export > transformations.jsonl
pnpm transformations:export --labelled-only > labelled.jsonl   # only turns a pipeline has ruled on
pnpm transformations:export --kind legacy > migrations.jsonl   # only migrations from a legacy source
```

## Everyday commands

```bash
pnpm dev              # both apps in watch mode
pnpm build            # production build
pnpm type-check       # tsc across the workspace
pnpm check            # format and lint with Biome

pnpm db:up            # start PostgreSQL
pnpm db:down          # stop it
pnpm db:migrate       # apply migrations
pnpm db:studio        # browse the database
```

## What next

Open the dashboard and start a project. The pages that covered configuration,
self-hosting and the underlying concepts are being rewritten; until they are back,
the environment variables are documented in `.env.docker.example` and the
`docker-compose.yml` at the repository root.
