#!/usr/bin/env bash
# =============================================================================
# monitor.sh — health-check and auto-recovery watchdog
# =============================================================================
# Installed by setup-server.sh to run via cron every 5 minutes.
# Checks:
#   1. Systemd service is active → restart if dead
#   2. Process memory usage hasn't blown past the limit
#   3. Log file is being written (no silent hang)
#   4. MATIC balance is above the gas floor (optional alert)
#   5. Optional: post alerts to a Slack/Discord webhook
#
# Usage (called automatically by cron):
#   /usr/local/bin/polymarket-monitor
#
# Manual usage:
#   bash scripts/monitor.sh
# =============================================================================

set -euo pipefail

SERVICE_NAME="polymarket-bot"
BOT_DIR="/opt/polymarket-bot"
LOG_FILE="${BOT_DIR}/logs/bot-$(date +%Y-%m-%d).log"
MAX_MEM_MB=800                   # restart if RSS exceeds this
LOG_STALE_SECS=300               # alert if no log write in 5 min
MATIC_FLOOR=0.5                  # warn if MATIC balance drops below this

# Optional webhook (set in .env or here directly)
SLACK_WEBHOOK="${SLACK_WEBHOOK_URL:-}"
DISCORD_WEBHOOK="${DISCORD_WEBHOOK_URL:-}"

# ── Load env ──────────────────────────────────────────────────────────────────
if [[ -f "${BOT_DIR}/.env" ]]; then
  # shellcheck disable=SC1091
  set +u
  source "${BOT_DIR}/.env"
  set -u
fi

TS="$(date '+%Y-%m-%d %H:%M:%S')"

# ── Alert helper ──────────────────────────────────────────────────────────────
send_alert() {
  local message="$1"
  echo "[${TS}] ALERT: ${message}"

  if [[ -n "${SLACK_WEBHOOK}" ]]; then
    curl -s -X POST "${SLACK_WEBHOOK}" \
      -H "Content-Type: application/json" \
      -d "{\"text\":\":warning: *Polymarket Bot Alert*\n${message}\"}" \
      --max-time 5 || true
  fi

  if [[ -n "${DISCORD_WEBHOOK}" ]]; then
    curl -s -X POST "${DISCORD_WEBHOOK}" \
      -H "Content-Type: application/json" \
      -d "{\"content\":\"⚠️ **Polymarket Bot Alert**\n${message}\"}" \
      --max-time 5 || true
  fi
}

log() {
  echo "[${TS}] $*"
}

# ── 1. Service status check ───────────────────────────────────────────────────
if ! systemctl is-active --quiet "${SERVICE_NAME}"; then
  send_alert "Service ${SERVICE_NAME} is DOWN — attempting restart"
  systemctl start "${SERVICE_NAME}" || true
  sleep 5

  if systemctl is-active --quiet "${SERVICE_NAME}"; then
    send_alert "Service ${SERVICE_NAME} restarted successfully"
    log "Service restarted OK"
  else
    send_alert "Service ${SERVICE_NAME} FAILED to restart. Manual intervention required."
    log "ERROR: Could not restart ${SERVICE_NAME}"
    journalctl -u "${SERVICE_NAME}" -n 20 --no-pager | tail -20
  fi
  exit 0
fi

log "Service ${SERVICE_NAME}: RUNNING"

# ── 2. Memory usage check ─────────────────────────────────────────────────────
MAIN_PID=$(systemctl show -p MainPID "${SERVICE_NAME}" --value 2>/dev/null || echo "0")

if [[ "${MAIN_PID}" != "0" && -f "/proc/${MAIN_PID}/status" ]]; then
  RSS_KB=$(grep VmRSS "/proc/${MAIN_PID}/status" | awk '{print $2}' || echo "0")
  RSS_MB=$((RSS_KB / 1024))

  if (( RSS_MB > MAX_MEM_MB )); then
    send_alert "Memory usage ${RSS_MB}MB exceeds limit ${MAX_MEM_MB}MB — restarting"
    systemctl restart "${SERVICE_NAME}"
    log "Restarted due to high memory (${RSS_MB}MB)"
  else
    log "Memory: ${RSS_MB}MB / ${MAX_MEM_MB}MB limit"
  fi
fi

# ── 3. Log freshness check ────────────────────────────────────────────────────
if [[ -f "${LOG_FILE}" ]]; then
  LAST_WRITE=$(stat -c %Y "${LOG_FILE}" 2>/dev/null || echo "0")
  NOW=$(date +%s)
  AGE=$(( NOW - LAST_WRITE ))

  if (( AGE > LOG_STALE_SECS )); then
    send_alert "Log file stale — no writes in ${AGE}s (limit: ${LOG_STALE_SECS}s). Bot may be hung."
    log "WARNING: log file stale (${AGE}s old)"
  else
    log "Log fresh: last write ${AGE}s ago"
  fi
else
  log "Log file not yet created: ${LOG_FILE}"
fi

# ── 4. MATIC balance check ─────────────────────────────────────────────────────
# Requires node + ethers to be importable; skip gracefully if not
POLYGON_RPC="${POLYGON_HTTPS_URL:-}"
WALLET_ADDR=""

if [[ -n "${PRIVATE_KEY:-}" ]]; then
  WALLET_ADDR=$(node -e "
    try {
      const { ethers } = require('ethers');
      const w = new ethers.Wallet(process.env.PRIVATE_KEY);
      console.log(w.address);
    } catch(e) { console.log(''); }
  " 2>/dev/null || echo "")
fi

if [[ -n "${POLYGON_RPC}" && -n "${WALLET_ADDR}" ]]; then
  MATIC_WEI=$(node -e "
    const { ethers } = require('ethers');
    const p = new ethers.JsonRpcProvider('${POLYGON_RPC}');
    p.getBalance('${WALLET_ADDR}')
      .then(b => console.log(b.toString()))
      .catch(() => console.log('0'));
  " 2>/dev/null || echo "0")

  MATIC_BAL=$(node -e "
    const { ethers } = require('ethers');
    console.log(parseFloat(ethers.formatEther('${MATIC_WEI}')).toFixed(4));
  " 2>/dev/null || echo "0")

  log "MATIC balance: ${MATIC_BAL}"

  # Compare using awk (bash doesn't do floats natively)
  if awk "BEGIN { exit !(${MATIC_BAL} < ${MATIC_FLOOR}) }"; then
    send_alert "MATIC balance ${MATIC_BAL} is below gas floor ${MATIC_FLOOR} — top up needed!"
  fi
fi

log "Health check complete — all systems nominal"
