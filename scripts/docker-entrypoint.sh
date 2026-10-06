#!/bin/sh
#
# Container entrypoint for the Terrablox dashboard.
#
# Checks the configuration the app cannot run without, optionally applies
# migrations, then hands the process over to Next.
#
# The checks are here rather than in the app because of when they fail. A missing
# BETTER_AUTH_SECRET does not stop Next from booting: the container goes healthy,
# serves the login page, and only breaks when someone tries to store an AWS
# credential. A deployment that refuses to start is a far cheaper way to find out.

set -eu

: "${PORT:=3001}"
: "${HOST:=0.0.0.0}"

fail() {
	echo "terrablox: $1" >&2
	exit 1
}

warn() {
	echo "terrablox: warning: $1" >&2
}

# --- required ---------------------------------------------------------------

[ -n "${DATABASE_URL:-}" ] ||
	fail "DATABASE_URL is not set - the app has no database to talk to."

# The signing secret is required to *serve*, but not to migrate.
#
# `prisma migrate deploy` touches the schema and nothing else, so the migration
# container has no use for a credential that can decrypt every stored secret. It used
# to be handed one purely because this check ran before the MIGRATE_ONLY branch below
# — the least-privilege fix is to check it only on the path that needs it.
if [ "${MIGRATE_ONLY:-false}" != "true" ]; then
	# Sessions are signed with this, and it is also HKDF-derived into the
	# AES-256-GCM key that encrypts stored AWS credentials and MCP auth headers
	# (apps/dashboard/src/lib/crypto/secret-box.ts). Two consequences worth knowing
	# before you rotate it: every session is invalidated, and every secret already
	# in the database becomes undecryptable.
	[ -n "${BETTER_AUTH_SECRET:-}" ] ||
		fail "BETTER_AUTH_SECRET is not set - sessions cannot be signed and stored secrets cannot be encrypted."

	# Length, not just presence. Better Auth accepts anything and falls back to a
	# constant it ships when the value is empty, so a placeholder like `changeme`
	# would sign sessions with something an attacker can guess. The app refuses to
	# boot on this too; catching it here names the variable instead of surfacing a
	# stack trace.
	if [ "${#BETTER_AUTH_SECRET}" -lt 32 ]; then
		fail "BETTER_AUTH_SECRET is ${#BETTER_AUTH_SECRET} characters - too short to be generated. Use: openssl rand -base64 32"
	fi
fi

# --- warnings ---------------------------------------------------------------

# Unset, the server falls back to http://localhost:3001
# (apps/dashboard/src/lib/auth/server.ts:15). Behind a load balancer that sends
# users to a callback URL on the wrong host, and the failure reads like a broken
# GitHub App rather than a missing variable.
if [ -z "${BETTER_AUTH_URL:-}" ] && [ -z "${NEXT_PUBLIC_APP_URL:-}" ]; then
	warn "neither BETTER_AUTH_URL nor NEXT_PUBLIC_APP_URL is set - OAuth callbacks will point at http://localhost:3001."
fi

# The likelier production mistake than leaving it unset: setting it to the http origin
# the proxy talks to instead of the https one users reach. Cookies then ship without
# Secure and OAuth callbacks come back over plaintext, and nothing else says so.
case "${BETTER_AUTH_URL:-}" in
http://localhost* | http://127.0.0.1* | "") ;;
http://*)
	warn "BETTER_AUTH_URL is ${BETTER_AUTH_URL} - session cookies will be sent without Secure. Use the https origin users reach."
	;;
esac

# GitHub is the only sign-in method and the same grant powers the agent, so
# without these the app runs and nobody can get in. Not fatal: it is a usable
# state for a first boot or a smoke test.
if [ -z "${GITHUB_CLIENT_ID:-}" ] || [ -z "${GITHUB_CLIENT_SECRET:-}" ]; then
	warn "GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET are not set - nobody will be able to sign in."
fi

# --- migrations -------------------------------------------------------------

# Off by default. Two containers starting at once would both run this, and
# concurrent `migrate deploy` on the same database is not something to discover
# during a rollout - run it as a one-off task, or accept the risk with a single
# instance by setting RUN_MIGRATIONS=true.
if [ "${RUN_MIGRATIONS:-false}" = "true" ]; then
	echo "terrablox: applying database migrations"
	cd /app/packages/database
	./node_modules/.bin/prisma migrate deploy
fi

# --- migrate-only mode ------------------------------------------------------

# `docker run --entrypoint ... -e MIGRATE_ONLY=true` gives the deployment
# pipeline a migration step out of the same image, with no server started.
if [ "${MIGRATE_ONLY:-false}" = "true" ]; then
	if [ "${RUN_MIGRATIONS:-false}" != "true" ]; then
		echo "terrablox: applying database migrations"
		cd /app/packages/database
		./node_modules/.bin/prisma migrate deploy
	fi
	echo "terrablox: migrations applied, exiting (MIGRATE_ONLY)"
	exit 0
fi

# --- server -----------------------------------------------------------------

cd /app/apps/dashboard

echo "terrablox: starting dashboard on ${HOST}:${PORT}"

# exec so Next replaces this shell and receives SIGTERM directly. Note that an
# agent turn can hold a request for up to 300s (maxDuration on the chat route),
# so give the platform a stop grace period above that or long turns die mid-flight.
exec ./node_modules/.bin/next start -p "$PORT" -H "$HOST"
