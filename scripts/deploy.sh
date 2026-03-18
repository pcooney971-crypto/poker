#!/usr/bin/env bash
# =============================================================================
# deploy.sh — zero-downtime hot-deploy to a running server
# =============================================================================
# Pulls latest code, rebuilds, and performs a graceful service restart.
# Safe to run repeatedly; the bot misses at most ~5 seconds of monitoring
# during the restart window.
#
# Usage (from your local machine):
#   bash scripts/deploy.sh <ssh-host>
#
# Example:
#   bash scripts/deploy.sh ubuntu@12.34.56.78
#   bash scripts/deploy.sh ec2-user@ec2-12-34-56-78.compute-1.amazonaws.com
#
# Prerequisites:
#   - SSH key authentication configured
#   - setup-server.sh has already been run on the target host
# =============================================================================

set -euo pipefail

SSH_HOST="${1:-}"
BOT_DIR="/opt/polymarket-bot"
SERVICE_NAME="polymarket-bot"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}  ✓  $*${NC}"; }
warn() { echo -e "${YELLOW}  ⚠  $*${NC}"; }
fail() { echo -e "${RED}  ✗  $*${NC}"; exit 1; }
step() { echo -e "\n\033[1;34m► $*\033[0m"; }

if [[ -z "${SSH_HOST}" ]]; then
  fail "Usage: $0 <ssh-host>  (e.g. ubuntu@12.34.56.78)"
fi

echo ""
echo "════════════════════════════════════════════════════════════"
echo "  DEPLOYING TO: ${SSH_HOST}"
echo "  $(date)"
echo "════════════════════════════════════════════════════════════"

# ── Verify SSH connectivity ───────────────────────────────────────────────────
step "Testing SSH connection"
ssh -o ConnectTimeout=10 -o BatchMode=yes "${SSH_HOST}" "echo connected" || \
  fail "Cannot reach ${SSH_HOST} via SSH"
ok "SSH connection OK"

# ── Run remote deploy commands ────────────────────────────────────────────────
ssh -o ConnectTimeout=30 "${SSH_HOST}" bash -s <<'REMOTE'
set -euo pipefail
BOT_DIR="/opt/polymarket-bot"
SERVICE_NAME="polymarket-bot"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { echo -e "${GREEN}  ✓  $*${NC}"; }
warn() { echo -e "${YELLOW}  ⚠  $*${NC}"; }
step() { echo -e "\n\033[1;34m► $*\033[0m"; }

cd "${BOT_DIR}"

step "Pulling latest code"
git fetch origin
CURRENT=$(git rev-parse HEAD)
git pull --ff-only
NEW=$(git rev-parse HEAD)

if [[ "${CURRENT}" == "${NEW}" ]]; then
  ok "Already up to date (${NEW:0:8})"
else
  ok "Updated ${CURRENT:0:8} → ${NEW:0:8}"
  git log --oneline "${CURRENT}..${NEW}"
fi

step "Installing dependencies"
sudo -u polybot npm ci --prefer-offline 2>&1 | tail -3
ok "Dependencies OK"

step "Building TypeScript"
sudo -u polybot npm run build 2>&1 | tail -5
ok "Build complete"

step "Graceful service restart"
systemctl reload-or-restart "${SERVICE_NAME}"
sleep 4

if systemctl is-active --quiet "${SERVICE_NAME}"; then
  ok "Service is RUNNING"
  systemctl status "${SERVICE_NAME}" --no-pager -l | head -12
else
  echo -e "${RED}  ✗  Service failed to start!${NC}"
  journalctl -u "${SERVICE_NAME}" -n 30 --no-pager
  exit 1
fi

step "Tail last 20 log lines"
journalctl -u "${SERVICE_NAME}" -n 20 --no-pager
REMOTE

ok "Deploy complete"
echo ""
echo "  Monitor with: ssh ${SSH_HOST} 'journalctl -u ${SERVICE_NAME} -f'"
echo ""
