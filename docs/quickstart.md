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
and writes into `apps/dashboard/.env`. To add them later, put them in that file as
`GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` and restart the dev server. If you
registered your own app rather than using `github.com/apps/terrablox`, also set
`GITHUB_APP_SLUG` to your app's slug so the in-app links point at it.

Then **install** the app on the account whose repositories you want to use. Signing
in and installing are two separate things: signing in identifies you, installing is
what grants access to repositories. Terrablox links to the install page wherever a
repository list is empty, and on the account screen under *Repository access*.

Choose *Only select repositories* — it is supported and recommended. Terrablox does
not create repositories: a project is imported from one that already exists. To start
a project, create an empty repository on GitHub with a README (the first commit is what
Terrablox commits on top of), add it to the installation's selection, and pick it in
*Import project*. The project is named after the repository. Only repositories without any `.tf` file are accepted, so the
Terraform root is always the repository root and there is nothing to configure.

## Module libraries

Terrablox keeps *module libraries* in sync: sets of Terraform module repositories that
users build projects from, next to the modules they import themselves. Every module
shows which library it comes from, and the modules page can filter by library.

All libraries are configured in one JSON array in `.env`, `TERRABLOX_MODULE_LIBRARIES`
(one line). Unset, it holds the two defaults:

```bash
TERRABLOX_MODULE_LIBRARIES=[{"id":"terrablox","name":"Terrablox","scope":"global","visible":true,"org":"terrablox","prefix":"terrablox-aws-","submoduleContainer":"modules"},{"id":"porsche","name":"Porsche","scope":"user","visible":true,"org":"porsche-code","topics":["aws","cbbac"]}]
```

| Field | |
| --- | --- |
| `id` | Slug stored on every row, e.g. `terrablox`. Required. |
| `name` | Label shown on every module. Required. |
| `scope` | `global` or `user` (see below). Required. |
| `visible` | `false` hides the library everywhere without touching its rows. Default `true`. |
| `org` | GitHub org or user. Required. |
| `prefix`, `topics` | Repository name prefix and/or topics, all of which must match. At least one is required. |
| `publicOnly` | Global only: list public repositories only. Default `true`. |
| `submoduleContainer` | Pinned submodule folder, e.g. `modules`. Default: detected. |
| `pipelineSecret` | Repository secret generated pipelines read for private modules. Default `TERRABLOX_<ID>_MODULES_TOKEN`. |

Adding an entry adds a library without any code change. `[]` means no libraries. An
invalid entry is skipped and logged. If the JSON is invalid as a whole, only the
public Terrablox entry is used.
There are two kinds:

- **Global** (`"scope": "global"`): one shared copy that every user sees, such as the
  **Terrablox** catalogue of AWS modules. An operator imports it with a token from
  the shell.
- **Per-user** (`"scope": "user"`): private repositories, such as **Porsche**. Each user's copy is read
  with that user's own GitHub token (see below).

Importing the Terrablox catalogue takes a GitHub token and a few minutes, so the
quickstart asks first. To import it later:

```bash
GITHUB_TOKEN=$(gh auth token) pnpm db:builtin:sync    # = db:library:sync --library terrablox
GITHUB_TOKEN=$(gh auth token) pnpm db:library:sync    # every global library
pnpm db:library:status                                # rows and visibility per library
```

`db:library:sync` re-imports every ref by default, which also refreshes the
analysis.
- `--changed-only` skips tags that are already imported. The default branch is
  always refreshed.
- `--prune` removes repositories the org no longer lists. Pruning is opt-in, because
  removing a shared module also removes it from every user's canvas.

Container startup never imports anything: a sync takes minutes and needs a token.

**Visibility is separate from importing.** `"visible": false` on an entry hides that
library from every list, picker, agent and API, without deleting any rows. Switching
it back on is instant, and a hidden library can still be imported in advance. While it's hidden, or before it has
been imported, a project whose Terraform calls one of its modules shows that call as a
node with no inputs or outputs.

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

A per-user library is an entry with `"scope": "user"` in `TERRABLOX_MODULE_LIBRARIES`.
To hide it without touching anyone's rows, set `"visible": false` on it.

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
