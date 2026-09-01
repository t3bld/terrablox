# syntax=docker/dockerfile:1.7
#
# TerraBlox dashboard - production image.
#
# Two things about this app decide the shape of this file.
#
# First, it spawns the GitHub Copilot CLI as a child process on every agent turn,
# and that CLI is a native binary shipped as a platform-specific optional
# dependency. Prisma's query engine is the same story. Both must therefore be
# installed *inside* the image: a node_modules built on a developer's Mac and
# copied in would carry darwin-arm64 artefacts and fail at the first chat
# message, which is a long way from the build that produced it.
#
# Second, next.config.mjs keeps @cdktf/hcl2json and @github/copilot-sdk out of
# the bundle on purpose - one resolves a .wasm payload relative to __dirname, the
# other resolves the CLI through the real node_modules layout. That rules out
# `output: "standalone"` unless someone verifies Next's file tracing copies a
# WASM blob, a 167 MB self-extracting executable and koffi's .node addon, which is
# exactly the class of asset tracing misses. So the image ships node_modules and
# runs `next start`.
#
# Debian rather than Alpine: glibc is what the Copilot CLI's default Linux package
# and Prisma's openssl-3.0.x engines are built against, so nothing has to be
# talked into working. Builds for linux/amd64 and linux/arm64 both resolve.
#
# Node 22, not 20. The SDK spawns the CLI with process.execPath, so the CLI's
# bundle runs on *this* image's Node, and that bundle uses Promise.withResolvers,
# which does not exist before Node 22. On Node 20 the app boots, serves every
# page, and then fails on the first chat message with a TypeError from a minified
# file - a long way from the version of Node that caused it.

# --- base --------------------------------------------------------------------

FROM node:22-bookworm-slim AS base

# openssl: Prisma's query engine links against it.
# tini: the app spawns Copilot CLI processes, and Node as PID 1 does not reap
#       children, so without an init the container slowly fills with zombies.
RUN apt-get update \
	&& apt-get install --no-install-recommends -y openssl ca-certificates tini \
	&& rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
ENV NEXT_TELEMETRY_DISABLED=1

# Pinned to the packageManager field in package.json so the image and a developer
# machine resolve the lockfile identically.
RUN corepack enable && corepack prepare pnpm@8.15.0 --activate

WORKDIR /app

# --- dependencies ------------------------------------------------------------

FROM base AS deps

# Manifests only, one per workspace package: the install layer then survives every
# source edit and is rebuilt only when a dependency actually changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/dashboard/package.json apps/dashboard/
COPY packages/auth/package.json packages/auth/
COPY packages/code-viewer/package.json packages/code-viewer/
COPY packages/database/package.json packages/database/
COPY packages/git-import/package.json packages/git-import/
COPY packages/graph/package.json packages/graph/
COPY packages/tsconfig/package.json packages/tsconfig/
COPY packages/ui/package.json packages/ui/

# @terrablox/database has a postinstall that runs `prisma generate`, so the schema
# has to be here before the install, not after it.
COPY packages/database/prisma packages/database/prisma

# Placeholders, and they stay placeholders: `prisma generate` only needs the
# datasource block to resolve, it never opens a connection. The real values
# arrive as runtime environment variables.
ENV DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder"
ENV DIRECT_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder"

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
	pnpm install --frozen-lockfile

# --- build -------------------------------------------------------------------

FROM deps AS builder

# node_modules is in .dockerignore, so this cannot clobber the install above.
COPY . .

# The only NEXT_PUBLIC_* variable in the app, and it is optional on purpose.
# Left unset, the browser client falls back to window.location.origin
# (apps/dashboard/src/app/providers.tsx:21), which keeps one image valid for
# every hostname you deploy it behind. Set it only if you need the client pinned
# to an absolute URL - baking a hostname into a bundle makes the image
# environment-specific, and staging would need its own build.
ARG NEXT_PUBLIC_APP_URL=""
ENV NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL}

ENV NODE_ENV=production

RUN pnpm --filter @terrablox/dashboard build

# Strip what a running server never opens. Left in, this image is 4.9 GB, and
# most of that is one directory: .next/cache is the webpack build cache, ~1.5 GB
# of incremental-compilation state that only `next build` reads. On Fargate that
# is pure cold-start latency.
#
# The platform packages are the subtler half. pnpm installs every Linux variant
# it finds in the lockfile, so a glibc image also carries the musl builds of the
# Copilot CLI, SWC and Biome — around 500 MB that detect-libc will never select
# on Debian. This is the one place in the file that depends on the base image
# being glibc: move to Alpine and these deletions become backwards.
RUN set -eu; \
	cd /app/apps/dashboard; \
	rm -rf .next/cache .next/trace .next/types; \
	cd /app; \
	rm -rf \
		node_modules/.pnpm/@github+copilot-linuxmusl-* \
		node_modules/.pnpm/@next+swc-*-musl@* \
		node_modules/.pnpm/@biomejs+cli-* \
		node_modules/.pnpm/@biomejs+biome@* \
		node_modules/.pnpm/turbo-linux-* \
		node_modules/.pnpm/turbo-darwin-* \
		node_modules/.pnpm/turbo-windows-* \
		node_modules/.pnpm/turbo@* \
		node_modules/.pnpm/@turbo+gen@* \
		node_modules/.pnpm/@turbo+workspaces@* \
		node_modules/.pnpm/typescript@*

# Removing packages out from under pnpm's symlink farm leaves dangling links in
# the per-package node_modules. Harmless — nothing the server loads follows them —
# but it is why this is a delete rather than a `pnpm install --prod`: a prod
# reinstall would drop the Prisma CLI needed for migrations and rewrite the store
# entry holding the generated client.

# Where the Copilot CLI's platform package landed, recorded rather than hardcoded:
# the path carries both the version and the architecture
# (@github+copilot-linux-arm64@1.0.79), so writing it out by hand would silently
# rot on the next dependency bump. This repeats npm-loader.js's own resolution -
# glibc or musl, then process.arch - so it picks the same directory the SDK would.
RUN node --input-type=module -e ' \
	import { createRequire } from "node:module"; \
	import { dirname } from "node:path"; \
	import { writeFileSync } from "node:fs"; \
	const appRequire = createRequire("/app/apps/dashboard/"); \
	const cliRequire = createRequire(appRequire.resolve("@github/copilot/npm-loader.js")); \
	const { isNonGlibcLinuxSync } = cliRequire("detect-libc"); \
	const variants = process.platform === "linux" ? (isNonGlibcLinuxSync() ? ["linuxmusl", "linux"] : ["linux"]) : [process.platform]; \
	for (const variant of variants) { \
		try { \
			writeFileSync("/app/.copilot-cli-dist", dirname(cliRequire.resolve(`@github/copilot-${variant}-${process.arch}`))); \
			process.exit(0); \
		} catch {} \
	} \
	console.error("no @github/copilot platform package for " + process.platform + "-" + process.arch); \
	process.exit(1); \
	'

# --- runtime -----------------------------------------------------------------

FROM base AS runner

ENV NODE_ENV=production
ENV PORT=3001
ENV HOST=0.0.0.0

# Deliberately not HOSTNAME, which Docker already sets to the container id -
# passing that to `next start -H` binds the server to a name nothing resolves.

# The pnpm layout is a web of relative symlinks into .pnpm, so every
# node_modules tree has to land at the path it was created at.
COPY --from=builder --chown=node:node /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/packages ./packages
COPY --from=builder --chown=node:node /app/apps/dashboard/node_modules ./apps/dashboard/node_modules
COPY --from=builder --chown=node:node /app/apps/dashboard/package.json ./apps/dashboard/package.json
COPY --from=builder --chown=node:node /app/apps/dashboard/next.config.mjs ./apps/dashboard/next.config.mjs
COPY --from=builder --chown=node:node /app/apps/dashboard/.next ./apps/dashboard/.next
COPY --from=builder --chown=node:node /app/apps/dashboard/public ./apps/dashboard/public
COPY --from=builder /app/.copilot-cli-dist /app/.copilot-cli-dist

# packages/ comes across whole rather than pruned: it carries prisma/migrations,
# which is what lets this same image run `prisma migrate deploy` as a one-off
# task instead of needing a second image built just for that.

# The Copilot CLI ships as a self-extracting executable: left alone, the first
# agent turn unpacks ~190 MB into ~/.cache/copilot/pkg before it will answer.
# In a container that is the worst of three worlds - it needs a large writable
# HOME, it rules out a read-only root filesystem, and it puts a native addon on a
# tmpfs, which is usually mounted noexec and then fails to load the addon at all.
#
# The package already contains the unpacked distribution next to the executable,
# and COPILOT_CLI_DIST_DIR is the switch that says "use it": the loader then skips
# extraction entirely. Symlinked to a stable path so the version- and
# architecture-specific directory stays an implementation detail.
RUN set -eu; \
	dist="$(cat /app/.copilot-cli-dist)"; \
	[ -x "$dist/copilot" ] || { echo "copilot executable missing at $dist" >&2; exit 1; }; \
	ln -s "$dist" /opt/copilot-cli; \
	rm /app/.copilot-cli-dist

ENV COPILOT_CLI_DIST_DIR=/opt/copilot-cli

# The image is the unit of versioning. Left on, the CLI checks for a newer release
# and tries to install it into a filesystem that is read-only.
ENV COPILOT_AUTO_UPDATE=false

# Fails the build rather than the first chat message if the CLI cannot start.
RUN /opt/copilot-cli/copilot --version

COPY --chown=node:node scripts/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# Unprivileged, and the two directories that are written to at runtime are made
# writable for it: /tmp holds the Copilot session state
# (apps/dashboard/src/lib/agent/copilot.ts:42), HOME is where the CLI keeps its
# own state. Neither needs to survive a restart - the transcript is in Postgres -
# so a read-only root filesystem plus tmpfs mounts works.
RUN mkdir -p /home/node/.cache && chown -R node:node /home/node
ENV HOME=/home/node
USER node

EXPOSE 3001

# /api/health answers without a session and without touching the database, so it
# reports "this process is serving" and nothing else. Database reachability
# belongs in a separate alarm, not in the signal that decides restarts.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker-entrypoint.sh"]
