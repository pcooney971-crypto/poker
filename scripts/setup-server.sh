#!/usr/bin/env bash
# =============================================================================
# setup-server.sh
# =============================================================================
# Fully automated EC2 server bootstrap script.
# Run this once as root (or via sudo) on a fresh Ubuntu 22.04 LTS instance.
#
# What this script does:
#   1. System update and essential packages
#   2. Node.js 20 LTS install
#   3. PM2 global install + systemd integration
#   4. Bot user creation (runs bot as non-root)
#   5. Code checkout (or in-place copy if already on server)
#   6. npm install + build
#   7. .env validation check
#   8. Preflight (on-chain init: approve + setApprovalForAll)
#   9. Systemd service install and start
#  10. Log rotation via logrotate
#  11. Cron-based health monitor
#
# Usage:
#   curl -fsSL https://your-repo/scripts/setup-server.sh | sudo bash
#   -- or --
#   sudo bash scripts/setup-server.sh
#
# Environment variables expected in /opt/polymarket-bot/.env before running.
# =============================================================================

set -euo pipefail

BOT_USER="polybot"
BOT_DIR="/opt/polymarket-bot"
LOG_DIR="/var/log/polymarket-bot"
SERVICE_NAME="polymarket-bot"
NODE_VERSION="20"
REPO_URL="${REPO_URL:-}"   # Set this to your git remote if cloning

# ── Colour helpers ───────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}  ✓  $*${NC}"; }
warn() { echo -e "${YELLOW}  ⚠  $*${NC}"; }
fail() { echo -e "${RED}  ✗  $*${NC}"; exit 1; }
step() { echo -e "\n\033[1;34m► $*\033[0m"; }

# ── Must be root ─────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  fail "This script must be run as root. Use: sudo bash setup-server.sh"
fi

echo ""
echo "════════════════════════════════════════════════════════════"
echo "  POLYMARKET HFT BOT — SERVER SETUP"
echo "  $(date)"
echo "════════════════════════════════════════════════════════════"

# ── 1. System update ─────────────────────────────────────────────────────────
step "1/11 — System update"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq \
  curl git build-essential ca-certificates gnupg jq logrotate \
  htop iotop net-tools unzip
ok "System packages installed"

# ── 2. Node.js 20 ────────────────────────────────────────────────────────────
step "2/11 — Installing Node.js ${NODE_VERSION}"
if command -v node &>/dev/null && [[ "$(node --version)" == v${NODE_VERSION}* ]]; then
  ok "Node.js $(node --version) already installed"
else
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | bash - 2>/dev/null
  apt-get install -y -qq nodejs
  ok "Node.js $(node --version) installed"
fi

ok "npm $(npm --version)"

# ── 3. PM2 ───────────────────────────────────────────────────────────────────
step "3/11 — Installing PM2"
npm install -g pm2 ts-node 2>/dev/null
ok "PM2 $(pm2 --version) installed"

# ── 4. Bot user ───────────────────────────────────────────────────────────────
step "4/11 — Creating bot user: ${BOT_USER}"
if id "${BOT_USER}" &>/dev/null; then
  ok "User ${BOT_USER} already exists"
else
  useradd --system --create-home --shell /bin/bash "${BOT_USER}"
  ok "User ${BOT_USER} created"
fi

# ── 5. Code setup ─────────────────────────────────────────────────────────────
step "5/11 — Setting up bot directory: ${BOT_DIR}"
if [[ -d "${BOT_DIR}/.git" ]]; then
  ok "Repo already present — pulling latest changes"
  sudo -u "${BOT_USER}" git -C "${BOT_DIR}" pull --ff-only || warn "git pull skipped (local changes)"
elif [[ -n "${REPO_URL}" ]]; then
  git clone "${REPO_URL}" "${BOT_DIR}"
  chown -R "${BOT_USER}:${BOT_USER}" "${BOT_DIR}"
  ok "Repository cloned to ${BOT_DIR}"
elif [[ -d "$(pwd)/src" && -f "$(pwd)/package.json" ]]; then
  # We're already inside the project directory — copy it
  cp -r "$(pwd)/." "${BOT_DIR}/"
  chown -R "${BOT_USER}:${BOT_USER}" "${BOT_DIR}"
  ok "Project files copied to ${BOT_DIR}"
else
  fail "No REPO_URL set and no project files found. Set REPO_URL or run from the project directory."
fi

# Check .env exists
if [[ ! -f "${BOT_DIR}/.env" ]]; then
  if [[ -f "${BOT_DIR}/.env.example" ]]; then
    warn ".env not found! Copy and fill it:"
    warn "  sudo cp ${BOT_DIR}/.env.example ${BOT_DIR}/.env"
    warn "  sudo nano ${BOT_DIR}/.env"
    fail "Stopping — .env is required before continuing."
  else
    fail ".env file missing in ${BOT_DIR}"
  fi
fi

# Restrict permissions on .env
chmod 600 "${BOT_DIR}/.env"
chown "${BOT_USER}:${BOT_USER}" "${BOT_DIR}/.env"
ok ".env permissions secured (600)"

# ── 6. npm install + build ────────────────────────────────────────────────────
step "6/11 — Installing dependencies and building"
cd "${BOT_DIR}"
sudo -u "${BOT_USER}" npm ci --prefer-offline 2>&1 | tail -5
sudo -u "${BOT_USER}" npm run build 2>&1 | tail -10
ok "Build complete: dist/main.js"

# ── 7. .env validation ────────────────────────────────────────────────────────
step "7/11 — Validating .env"
REQUIRED_VARS=(
  PRIVATE_KEY POLYGON_WSS_URL POLYGON_HTTPS_URL
  CHECKWX_API_KEY METAR_STATIONS
  CONDITION_ID YES_TOKEN_ID NO_TOKEN_ID
  POLYMARKET_API_KEY POLYMARKET_API_SECRET POLYMARKET_API_PASSPHRASE
  TEMP_THRESHOLD
)

set +u   # allow unset during sourcing
# shellcheck disable=SC1091
source "${BOT_DIR}/.env"
set -u

MISSING=0
for VAR in "${REQUIRED_VARS[@]}"; do
  if [[ -z "${!VAR:-}" ]]; then
    warn "Missing in .env: ${VAR}"
    MISSING=1
  fi
done

if [[ $MISSING -eq 1 ]]; then
  fail "Fill in all required env vars then re-run setup."
fi
ok "All required env vars present"

# ── 8. Preflight (on-chain init) ──────────────────────────────────────────────
step "8/11 — Running preflight (on-chain approvals)"
if [[ -f "${BOT_DIR}/.preflight_ok" ]]; then
  ok "Preflight already completed — skipping"
else
  echo "  Running: npx ts-node scripts/preflight.ts"
  cd "${BOT_DIR}"
  sudo -u "${BOT_USER}" npx ts-node scripts/preflight.ts || fail "Preflight failed. See errors above."
fi

# ── 9. Systemd service ────────────────────────────────────────────────────────
step "9/11 — Installing systemd service"

# Create log directory
mkdir -p "${LOG_DIR}"
chown "${BOT_USER}:${BOT_USER}" "${LOG_DIR}"

# Write the unit file (also generated by systemd/ in the project)
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<SERVICE
[Unit]
Description=Polymarket HFT Weather Arbitrage Bot
Documentation=file://${BOT_DIR}/README.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${BOT_USER}
WorkingDirectory=${BOT_DIR}
EnvironmentFile=${BOT_DIR}/.env
ExecStartPre=/usr/bin/node -e "require('./dist/main.js')" --dry-run 2>/dev/null || true
ExecStart=/usr/bin/node ${BOT_DIR}/dist/main.js
Restart=always
RestartSec=10
RestartPreventExitStatus=3

# Logging (journalctl -u polymarket-bot -f)
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=${BOT_DIR}/logs ${LOG_DIR}
PrivateTmp=true

# Limits
LimitNOFILE=65536
TimeoutStartSec=60
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl start  "${SERVICE_NAME}"

# Wait a few seconds and check it came up
sleep 5
if systemctl is-active --quiet "${SERVICE_NAME}"; then
  ok "Service ${SERVICE_NAME} is RUNNING"
else
  warn "Service did not start cleanly. Check: journalctl -u ${SERVICE_NAME} -n 50"
fi

# ── 10. Log rotation ─────────────────────────────────────────────────────────
step "10/11 — Configuring logrotate"
cat > "/etc/logrotate.d/${SERVICE_NAME}" <<LOGROTATE
${BOT_DIR}/logs/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    create 0640 ${BOT_USER} ${BOT_USER}
    sharedscripts
    postrotate
        systemctl kill -s HUP ${SERVICE_NAME} 2>/dev/null || true
    endscript
}
LOGROTATE
ok "logrotate configured"

# ── 11. Health monitor cron ───────────────────────────────────────────────────
step "11/11 — Installing health-check cron job"

# Install the monitor script
cp "${BOT_DIR}/scripts/monitor.sh" "/usr/local/bin/polymarket-monitor"
chmod +x "/usr/local/bin/polymarket-monitor"

# Run every 5 minutes
CRON_LINE="*/5 * * * * root /usr/local/bin/polymarket-monitor >> /var/log/polymarket-bot/monitor.log 2>&1"
if grep -q "polymarket-monitor" /etc/crontab 2>/dev/null; then
  ok "Cron job already present"
else
  echo "${CRON_LINE}" >> /etc/crontab
  ok "Cron health-check installed (every 5 minutes)"
fi

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════════"
echo "  SETUP COMPLETE"
echo ""
echo "  Service:  systemctl status ${SERVICE_NAME}"
echo "  Logs:     journalctl -u ${SERVICE_NAME} -f"
echo "  Logfiles: ${BOT_DIR}/logs/"
echo "  Restart:  systemctl restart ${SERVICE_NAME}"
echo "  Stop:     systemctl stop    ${SERVICE_NAME}"
echo "════════════════════════════════════════════════════════════"
echo ""
