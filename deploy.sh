#!/usr/bin/env sh
# Deploy / update the Catan server on this machine.
#
#   ./deploy.sh                          http on port 8080
#   DOMAIN=catan.example.com ./deploy.sh https through Caddy (ports 80/443; the game port stays local)
#   PORT=9080 ./deploy.sh                another port (remembered for later runs)
#   PORT=9080 BIND=127.0.0.1 TRUST_PROXY=1 ./deploy.sh
#                                        behind Cloudflare Tunnel on this machine: game port local only,
#                                        real player addresses from X-Forwarded-For
#   ./deploy.sh --install-cron          also redeploy every Monday 04:17 (pulls code and patched images)
#   ./deploy.sh --no-pull                deploy what is checked out, without git pull
#
# Each run: git pull, rebuild on the newest node:22-alpine (--pull), check for known vulnerabilities, restart
# with the hardened settings in docker-compose.yml, wait until the server answers. Accounts stay in the
# catan-data volume. Settings are remembered in .deploy.env, so the cron job and later runs reuse them.
set -eu

cd "$(dirname "$0")"
HERE=$(pwd)
ENV_FILE="$HERE/.deploy.env"
LOG="$HERE/deploy.log"

PULL=1
CRON=0
for arg in "$@"; do
  case "$arg" in
    --no-pull) PULL=0 ;;
    --install-cron) CRON=1 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\n== %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- settings (command line wins over .deploy.env)
CLI_DOMAIN=${DOMAIN-__unset__}
CLI_PORT=${PORT-__unset__}
CLI_BIND=${BIND-__unset__}
CLI_TRUST=${TRUST_PROXY-__unset__}
DOMAIN='' PORT='' BIND='' TRUST_PROXY=''
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
[ "$CLI_DOMAIN" != __unset__ ] && DOMAIN=$CLI_DOMAIN
[ "$CLI_PORT" != __unset__ ] && PORT=$CLI_PORT
[ "$CLI_BIND" != __unset__ ] && BIND=$CLI_BIND
[ "$CLI_TRUST" != __unset__ ] && TRUST_PROXY=$CLI_TRUST
PORT=${PORT:-8080}
printf 'DOMAIN=%s\nPORT=%s\nBIND=%s\nTRUST_PROXY=%s\n' "$DOMAIN" "$PORT" "$BIND" "$TRUST_PROXY" > "$ENV_FILE"

if [ -n "$DOMAIN" ]; then
  BIND=${BIND:-127.0.0.1} TRUST_PROXY=${TRUST_PROXY:-1}
  PROFILE="--profile https"
  URL="https://$DOMAIN"
else
  BIND=${BIND:-0.0.0.0} TRUST_PROXY=${TRUST_PROXY:-0}
  PROFILE=""
  URL="http://$([ "$BIND" = 0.0.0.0 ] && echo '<ip-may-ao>' || echo "$BIND"):$PORT"
fi
export DOMAIN PORT BIND TRUST_PROXY
echo "port $BIND:$PORT, https via Caddy: ${DOMAIN:-no}, trust proxy: $TRUST_PROXY"

# ---------------------------------------------------------------- tools
command -v docker >/dev/null || die "docker is not installed (https://docs.docker.com/engine/install/)"
docker info >/dev/null 2>&1 || die "cannot talk to docker: start it, or add this user to the docker group / use rootless docker"
if docker compose version >/dev/null 2>&1; then COMPOSE="docker compose"
elif command -v docker-compose >/dev/null; then COMPOSE="docker-compose"
else die "docker compose plugin is missing (apt install docker-compose-plugin)"
fi
DC="$COMPOSE $PROFILE"

# A container from an older "docker run" by hand holds the name and the port: compose replaces it.
if docker ps -a --format '{{.Names}}' | grep -qx catan && \
   [ -z "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' catan 2>/dev/null)" ]; then
  say "removing the old hand-started 'catan' container (accounts are in the volume, they stay)"
  docker rm -f catan >/dev/null
fi

# ---------------------------------------------------------------- code
if [ "$PULL" = 1 ] && [ -d .git ]; then
  say "git pull"
  git pull --ff-only || die "git pull failed (local changes?). Fix it, or run with --no-pull"
fi

# ---------------------------------------------------------------- build on patched images
say "build (newest node:22-alpine)"
$DC build --pull
[ -n "$DOMAIN" ] && $DC pull caddy

# ---------------------------------------------------------------- vulnerability checks (warn, do not block)
say "vulnerability check"
if docker run --rm --entrypoint sh node:22-alpine -c 'true' >/dev/null 2>&1; then
  # npm is stripped from the final image, so audit the lock file in a throwaway node container.
  docker run --rm -v "$HERE/package.json:/a/package.json:ro" -v "$HERE/package-lock.json:/a/package-lock.json:ro" \
    -w /a node:22-alpine npm audit --omit=dev --audit-level=high \
    && echo "npm audit: no high/critical problems" \
    || echo "WARNING: npm audit found problems: update package-lock.json (npm update, npm audit fix) and push"
fi
if command -v trivy >/dev/null; then
  trivy image --quiet --severity HIGH,CRITICAL --ignore-unfixed catan-server \
    || echo "WARNING: trivy found fixable HIGH/CRITICAL issues in the image"
elif docker scout version >/dev/null 2>&1; then
  docker scout cves --only-severity critical,high --only-fixed catan-server \
    || echo "WARNING: docker scout found fixable issues"
else
  echo "(install trivy for an image scan: https://trivy.dev)"
fi

# ---------------------------------------------------------------- start
say "start"
if [ -z "$DOMAIN" ] && docker ps --format '{{.Names}}' | grep -qx catan-caddy; then
  docker rm -f catan-caddy >/dev/null   # switched back from https to plain http
fi
$DC up -d --remove-orphans

say "waiting for the server"
i=0
until [ "$(docker inspect -f '{{.State.Health.Status}}' catan 2>/dev/null)" = healthy ]; do
  i=$((i + 1))
  if [ $i -gt 30 ]; then
    docker logs --tail 40 catan
    die "server did not become healthy in 60 s (logs above)"
  fi
  sleep 2
done
docker image prune -f >/dev/null 2>&1 || true
echo "OK: $URL"

# ---------------------------------------------------------------- weekly redeploy
if [ "$CRON" = 1 ]; then
  command -v crontab >/dev/null || die "crontab not found (apt install cron)"
  line="17 4 * * 1 cd '$HERE' && ./deploy.sh >> '$LOG' 2>&1"
  ( crontab -l 2>/dev/null | grep -v "deploy.sh" ; echo "$line" ) | crontab -
  echo "cron: every Monday 04:17, log in $LOG"
fi
