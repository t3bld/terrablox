#!/usr/bin/env bash
#
# TerraBlox quick start.
#
# Brings a fresh clone to a running dev environment:
#   prerequisites -> env files -> dependencies -> database -> migrations -> dev server
#
# Safe to re-run: existing .env files and data are never overwritten.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

APP_ENV="apps/dashboard/.env"
APP_ENV_EXAMPLE="apps/dashboard/.env.example"
# The Prisma CLI resolves env vars relative to the schema, so it needs its own
# file. It holds only the connection string - no secrets are duplicated.
DB_ENV="packages/database/.env"
DB_ENV_EXAMPLE="packages/database/.env.example"
DB_SERVICE="postgres"
# Not the default filename, so every compose call must pass it explicitly.
COMPOSE_FILE="docker-compose.local.yml"
DB_USER="terrablox"
DB_NAME="terrablox"
DASHBOARD_PORT=3001
DASHBOARD_URL="http://localhost:${DASHBOARD_PORT}"

START_DEV=1

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
	BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'
	GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BLUE=$'\033[34m'; RESET=$'\033[0m'
else
	BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; BLUE=""; RESET=""
fi

step()  { printf '\n%s==>%s %s%s%s\n' "$BLUE" "$RESET" "$BOLD" "$1" "$RESET"; }
info()  { printf '    %s\n' "$1"; }
muted() { printf '    %s%s%s\n' "$DIM" "$1" "$RESET"; }
ok()    { printf '    %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn()  { printf '    %s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
die()   { printf '\n%serror:%s %s\n' "$RED" "$RESET" "$1" >&2; exit 1; }

usage() {
	cat <<EOF
${BOLD}TerraBlox quick start${RESET}

Usage: pnpm quickstart [options]
       ./scripts/quickstart.sh [options]

Options:
  -n, --no-dev   Set everything up but do not start the dev server.
  -h, --help     Show this help.

Checks prerequisites, creates the .env files (generating a BETTER_AUTH_SECRET),
installs dependencies, starts PostgreSQL in Docker, applies migrations and
finally runs \`pnpm dev\`.
EOF
}

while [ $# -gt 0 ]; do
	case "$1" in
		-n|--no-dev) START_DEV=0 ;;
		-h|--help)   usage; exit 0 ;;
		*)           printf '%serror:%s unknown option: %s\n\n' "$RED" "$RESET" "$1" >&2; usage >&2; exit 1 ;;
	esac
	shift
done

# --- 1. prerequisites -------------------------------------------------------

step "Checking prerequisites"

command -v node >/dev/null 2>&1 || die "node is not installed. See https://nodejs.org"
command -v pnpm >/dev/null 2>&1 || die "pnpm is not installed. Run: npm install -g pnpm"
command -v docker >/dev/null 2>&1 || die "docker is not installed. See https://docs.docker.com/get-docker/"

node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 18 ] || die "Node 18 or newer is required (found $(node -v))."
ok "node $(node -v), pnpm $(pnpm -v)"

docker compose version >/dev/null 2>&1 || die "'docker compose' is unavailable. Please update Docker."

if ! docker info >/dev/null 2>&1; then
	warn "Docker daemon is not running."
	if [ "$(uname -s)" = "Darwin" ] && [ -d "/Applications/Docker.app" ]; then
		info "Starting Docker Desktop..."
		open -a Docker
		for _ in $(seq 1 60); do
			docker info >/dev/null 2>&1 && break
			sleep 2
		done
	fi
	docker info >/dev/null 2>&1 || die "Docker daemon is still not reachable. Start Docker and re-run."
fi
ok "docker daemon is running"

# --- 2. env files -----------------------------------------------------------

step "Preparing environment files"

[ -f "$APP_ENV_EXAMPLE" ] || die "$APP_ENV_EXAMPLE is missing."
[ -f "$DB_ENV_EXAMPLE" ] || die "$DB_ENV_EXAMPLE is missing."

# Reads the raw value of KEY from an env file, stripping surrounding quotes.
read_env_var() {
	local file="$1" key="$2" value
	[ -f "$file" ] || return 0
	value="$(grep -E "^[[:space:]]*${key}=" "$file" | head -n 1 | cut -d= -f2- || true)"
	value="${value%\"}"; value="${value#\"}"
	value="${value%\'}"; value="${value#\'}"
	printf '%s' "$value"
}

# Sets KEY=VALUE in an env file, replacing the existing line or appending a new one.
write_env_var() {
	local file="$1" key="$2" value="$3" tmp
	tmp="$(mktemp)"
	if grep -qE "^[[:space:]]*${key}=" "$file"; then
		awk -v key="$key" -v value="$value" '
			!done && $0 ~ "^[[:space:]]*" key "=" { print key "=" value; done = 1; next }
			{ print }
		' "$file" >"$tmp"
	else
		cat "$file" >"$tmp"
		printf '%s=%s\n' "$key" "$value" >>"$tmp"
	fi
	cat "$tmp" >"$file"
	rm -f "$tmp"
}

# Creates an env file from its example, keeping an existing file untouched.
ensure_env_file() {
	local example="$1" target="$2"
	if [ -f "$target" ]; then
		muted "$target already exists, keeping it"
		return
	fi
	mkdir -p "$(dirname "$target")"
	cp "$example" "$target"
	ok "created $target"
}

ensure_env_file "$APP_ENV_EXAMPLE" "$APP_ENV"
ensure_env_file "$DB_ENV_EXAMPLE" "$DB_ENV"

# The session secret lives only in the dashboard env; nothing else reads it.
if [ -z "$(read_env_var "$APP_ENV" BETTER_AUTH_SECRET)" ]; then
	write_env_var "$APP_ENV" BETTER_AUTH_SECRET \
		"$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))')"
	ok "generated BETTER_AUTH_SECRET in $APP_ENV"
else
	muted "BETTER_AUTH_SECRET already set, left unchanged"
fi

if [ "$(read_env_var "$APP_ENV" DATABASE_URL)" != "$(read_env_var "$DB_ENV" DATABASE_URL)" ]; then
	warn "DATABASE_URL differs between $APP_ENV and $DB_ENV"
	info "the app and the Prisma CLI would talk to different databases"
fi

# --- 2b. GitHub sign-in -----------------------------------------------------

# Not optional, and this used to say it was. Email and password sign-in was
# removed, so GitHub OAuth is now the only way in: without these two values the
# script finishes happily and the login page cannot do anything. Asking here is
# the difference between a five-minute setup and a puzzle.

# Asks for one env var and writes it, leaving an existing value alone.
# prompt_env_var FILE KEY LABEL [secret]
prompt_env_var() {
	local file="$1" key="$2" label="$3" secret="${4:-}" value=""

	if [ -n "$(read_env_var "$file" "$key")" ]; then
		muted "$key already set, left unchanged"
		return 0
	fi

	if [ ! -t 0 ]; then
		warn "$key is empty and this is not an interactive terminal"
		return 1
	fi

	if [ -n "$secret" ]; then
		# Not echoed: a client secret pasted into a prompt would otherwise sit in
		# the terminal scrollback for the rest of the day.
		printf '    %s%s%s ' "$BOLD" "$label" "$RESET"
		read -rs value </dev/tty || value=""
		printf '\n'
	else
		printf '    %s%s%s ' "$BOLD" "$label" "$RESET"
		read -r value </dev/tty || value=""
	fi

	value="$(printf '%s' "$value" | tr -d '[:space:]')"
	[ -n "$value" ] || return 1

	write_env_var "$file" "$key" "$value"
	ok "$key written to $file"
}

github_ready() {
	[ -n "$(read_env_var "$APP_ENV" GITHUB_CLIENT_ID)" ] &&
		[ -n "$(read_env_var "$APP_ENV" GITHUB_CLIENT_SECRET)" ]
}

if github_ready; then
	ok "GitHub sign-in is configured"
else
	step "Configuring GitHub sign-in (required)"
	info "Client ID and client secret of a GitHub OAuth app are needed."
	printf '\n'

	prompt_env_var "$APP_ENV" GITHUB_CLIENT_ID "Client ID:      " || true
	prompt_env_var "$APP_ENV" GITHUB_CLIENT_SECRET "Client secret:  " secret || true

	if github_ready; then
		ok "GitHub sign-in is configured"
	else
		warn "GitHub sign-in is NOT configured - nobody can sign in yet"
		info "add GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to $APP_ENV, then restart the dev server"
	fi
fi

# --- 3. dependencies --------------------------------------------------------

step "Installing dependencies"
pnpm install
ok "dependencies installed"

# Cheap and idempotent; guarantees the client matches schema.prisma even when
# `pnpm install` was a no-op and therefore skipped the postinstall hook.
pnpm db:generate >/dev/null
ok "prisma client generated"

# The agent spawns the Copilot CLI as a child process, so there is no service to
# start - but a missing binary would only surface on the first chat message.
if (cd apps/dashboard && node -e 'require.resolve("@github/copilot/npm-loader.js")') >/dev/null 2>&1; then
	ok "copilot cli available (the project agent runs on each user's own subscription)"
else
	warn "@github/copilot did not resolve - the project agent will fail. Re-run: pnpm install"
fi

# --- 4. database ------------------------------------------------------------

step "Starting PostgreSQL"

docker compose -f "$COMPOSE_FILE" up -d "$DB_SERVICE"

container_id="$(docker compose -f "$COMPOSE_FILE" ps -q "$DB_SERVICE")"
[ -n "$container_id" ] || die "Could not determine the '$DB_SERVICE' container id."

db_ready() {
	local health
	health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id" 2>/dev/null || echo none)"
	[ "$health" = "healthy" ] && return 0
	docker exec "$container_id" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1
}

info "Waiting for the database to accept connections..."
for _ in $(seq 1 60); do
	db_ready && break
	sleep 2
done
db_ready || die "PostgreSQL did not become ready. Check: docker compose -f $COMPOSE_FILE logs $DB_SERVICE"
ok "postgres is ready on localhost:5433"

# --- 5. migrations ----------------------------------------------------------

step "Applying database migrations"
pnpm db:migrate
ok "schema is up to date"

# --- 5b. built-in module catalogue ------------------------------------------

# TerraBlox ships with ~50 standard AWS modules (terraform-aws-modules forks).
# They need a GitHub token (no scopes required for public repos) and a few
# minutes to import. The user gets to decide.
step "Built-in module catalogue"

builtin_flag="$(read_env_var "$APP_ENV" TERRABLOX_BUILTIN_MODULES)"

if [ "$builtin_flag" = "false" ] || [ "$builtin_flag" = "0" ]; then
	muted "TERRABLOX_BUILTIN_MODULES is false - skipping"
elif [ ! -t 0 ]; then
	# Non-interactive (CI, piped): import automatically if token available.
	builtin_token="${TERRABLOX_SEED_GITHUB_TOKEN:-${GITHUB_TOKEN:-${GH_TOKEN:-}}}"
	if [ -z "$builtin_token" ] && command -v gh >/dev/null 2>&1; then
		builtin_token="$(gh auth token 2>/dev/null || true)"
	fi
	if [ -z "$builtin_token" ]; then
		warn "no GitHub token found - skipping built-in modules"
		info "run later: GITHUB_TOKEN=\$(gh auth token) pnpm db:builtin:sync"
	else
		info "importing the terrablox-aws-* catalogue..."
		if GITHUB_TOKEN="$builtin_token" pnpm db:builtin:sync; then
			ok "built-in modules are available to every user"
		else
			warn "the catalogue did not import cleanly - re-run: pnpm db:builtin:sync"
		fi
	fi
else
	# Interactive terminal: ask the user.
	printf '\n'
	printf '    %sImport TerraBlox best practice terraform modules catalogue? [Y/n]%s ' "$BOLD" "$RESET"
	read -r answer </dev/tty || answer=""
	case "$answer" in
		[nN]|[nN][oO])
			muted "skipping - import later with: GITHUB_TOKEN=\$(gh auth token) pnpm db:builtin:sync"
			;;
		*)
			builtin_token="${TERRABLOX_SEED_GITHUB_TOKEN:-${GITHUB_TOKEN:-${GH_TOKEN:-}}}"
			if [ -z "$builtin_token" ] && command -v gh >/dev/null 2>&1; then
				builtin_token="$(gh auth token 2>/dev/null || true)"
			fi
			if [ -z "$builtin_token" ]; then
				warn "no GitHub token found - gh CLI not logged in?"
				info "run: gh auth login && GITHUB_TOKEN=\$(gh auth token) pnpm db:builtin:sync"
			else
				info "importing..."
				if GITHUB_TOKEN="$builtin_token" pnpm db:builtin:sync; then
					ok "built-in modules are available to every user"
				else
					warn "the catalogue did not import cleanly - re-run: pnpm db:builtin:sync"
				fi
			fi
			;;
	esac
fi

# --- 5c. configuration summary ----------------------------------------------

# Every variable the code actually reads, with what its absence costs. Built by
# grepping for `process.env.` rather than from memory, because a list maintained
# by hand beside a growing codebase is a list that quietly goes stale — which is
# exactly how GitHub sign-in came to be documented as optional.
step "Configuration"

summarise_var() {
	local key="$1" need="$2" note="$3" value
	value="$(read_env_var "$APP_ENV" "$key")"

	if [ -n "$value" ]; then
		ok "$key"
		return
	fi

	case "$need" in
		required) warn "$key — $note" ;;
		*)        muted "$key — $note (optional)" ;;
	esac
}

summarise_var DATABASE_URL required "the app cannot reach Postgres"
summarise_var BETTER_AUTH_SECRET required "sessions and stored secrets cannot be signed"
summarise_var GITHUB_CLIENT_ID required "nobody can sign in"
summarise_var GITHUB_CLIENT_SECRET required "nobody can sign in"

printf '\n'
muted "Edit $APP_ENV and restart the dev server to change any of these."

# --- 6. dev server ----------------------------------------------------------

if [ "$START_DEV" -eq 0 ]; then
	step "Setup complete"
	info "Start the app with: pnpm dev"
	info "The dashboard will be at $DASHBOARD_URL"
	exit 0
fi

if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$DASHBOARD_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
	step "Setup complete"
	warn "Port $DASHBOARD_PORT is already in use, so the dev server was not started."
	info "A dev server is most likely already running: $DASHBOARD_URL"
	exit 0
fi

step "Starting the development servers"
info "Dashboard: $DASHBOARD_URL"
muted "Press Ctrl+C to stop. Postgres keeps running ('pnpm db:down' stops it)."
printf '\n'

exec pnpm dev
