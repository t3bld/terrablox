---
title: Documentation
description: What Terrablox is, and where to find the part you need.
order: 0
---

Terrablox designs AWS infrastructure and commits it as real Terraform to your own
repository. There is no proprietary format in between: what you see on the canvas is
the `module` blocks in your `main.tf`, and deleting Terrablox leaves a repository
that still deploys.

It is open source under AGPL-3.0 and designed to be self-hosted. No managed service
is required to run it.

## Where to start

**[Quickstart](/docs/quickstart)** — one command to a running instance on your own
machine. It is the only page here for now; the rest of the documentation is being
rewritten.

## What you need

Three things, and none of them are ours:

| | |
|---|---|
| A GitHub account | The only sign-in method, and where your Terraform lives |
| A GitHub Copilot seat | Every agent turn runs on your own subscription and quota |
| An AWS account | Only when you want to deploy. Designing needs none |

Terrablox holds no model API key and no long-lived cloud credential. That is a
property of the architecture rather than a policy: there is nowhere in the schema
for either of them.

## Improving these pages

Every page here is a Markdown file in
[`docs/`](https://github.com/t3bld/terrablox/tree/main/docs). The link at the bottom
of a page opens that file in the GitHub editor. Adding a file adds a page — the
navigation is built from the front matter, so there is no index to update.
