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

You will also want a **GitHub App**, which the script asks for. Registering one takes
a couple of minutes and the next section explains it.

## Run it

```bash
git clone https://github.com/t3bld/terrablox.git
cd terrablox
pnpm quickstart
```

That single command checks the prerequisites, writes the `.env` files, generates a
session secret, installs dependencies, starts PostgreSQL in Docker, applies the
database migrations, offers to import the module catalogue and then starts the dev
server. It is safe to re-run: existing `.env` files and existing data are never
overwritten.

The dashboard is then at **http://localhost:3001**.

## Registering the GitHub App

GitHub sign-in is required — it is the only way in, and the same grant is what lets
the agent read and write your repositories. Without it the app starts and the login
page can do nothing.

It has to be a **GitHub App**. A classic OAuth App will let you sign in and nothing
more: Terrablox asks GitHub which repositories the *installation* was granted, and
those endpoints reject an OAuth token, so every repository picker comes back empty.

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
| Repository → Contents | Read and write | read Terraform, commit the graph |
| Repository → Workflows | Read and write | commits touching `.github/workflows/` are refused without it, *on top of* Contents |
| Repository → Actions | Read and write | start a deployment run and follow it |
| Repository → Variables | Read and write | the pipeline's configuration |
| Repository → Administration | Read and write | creating a project's repository |
| Account → Email addresses | Read | so GitHub returns a primary email |

Leave everything else off. In particular **not** *Copilot Chat*: it sounds relevant
because the agent runs on Copilot, but it is the permission for Copilot Extensions,
which receive a user's chat messages. Terrablox calls Copilot rather than being
called by it, and enabling it would only add a data-sharing line to the consent
screen.

There are no scopes to configure. GitHub Apps use permissions instead, and the
`scope` parameter is ignored — which is why the app requests none.

**Afterwards**

You end up with a client ID and a client secret, which `pnpm quickstart` prompts for
and writes into `apps/dashboard/.env`. To add them later, put them in that file as
`GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` and restart the dev server. If you
registered your own app rather than using `github.com/apps/terrablox`, also set
`GITHUB_APP_SLUG` to your app's slug so the in-app links point at it.

Then **install** the app on the account whose repositories you want to use. Signing
in and installing are two separate things: signing in identifies you, installing is
what grants access to repositories. Terrablox links to the install page wherever a
repository list is empty, and on the account screen under *Repository access*.

One thing worth knowing when you choose *Only select repositories*: creating a
project creates a repository, and a new repository is not part of that selection.
Terrablox refuses before creating anything and says so, rather than leaving an
unusable repository behind. Choosing *All repositories* avoids it.

## The module catalogue

Terrablox ships with a curated catalogue of AWS modules. Importing it needs a GitHub
token and a few minutes, so the quickstart asks rather than deciding for you.

To import it later:

```bash
GITHUB_TOKEN=$(gh auth token) pnpm db:builtin:sync
pnpm db:builtin:status
```

Until it has run, a project whose Terraform calls one of these modules renders it as
a node with no inputs or outputs. `TERRABLOX_BUILTIN_MODULES=false` hides the
catalogue without deleting it, so turning it back on is instant.

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
