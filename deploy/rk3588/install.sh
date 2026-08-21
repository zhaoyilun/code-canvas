#!/usr/bin/env bash
# On-device installer for the RK3588 offline kiosk appliance.
# Run from the transferred bundle directory. Assumes:
#   - Ubuntu 22.04, docker already installed (see runbook for offline docker)
#   - RoboFrame works: `source /opt/IB_Robot/install/setup.sh && robot-skill --help`
#   - Logged-in desktop user for the kiosk autostart

set -euo pipefail

BUNDLE_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_ROOT="/opt/n8n-rk3588"
BRIDGE_ROOT="/opt/roboframe-bridge"
BRIDGE_ENV="/etc/roboframe-bridge.env"
IB_ROBOT_DIR="${IB_ROBOT_DIR:-/opt/IB_Robot}"

[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)"; exit 1; }

echo "==> [1/6] Loading docker image"
IMAGE_TAR=$(ls n8n-rk3588-*.tar.gz | head -1)
gunzip -c "${IMAGE_TAR}" | docker load
TAG=$(docker images --format '{{.Repository}}:{{.Tag}}' n8n-rk3588 | head -1)
echo "    loaded: ${TAG}"

echo "==> [2/6] Installing files"
mkdir -p "${INSTALL_ROOT}/kiosk" "${BRIDGE_ROOT}"
tar -xzf rk3588-files.tar.gz -C "${INSTALL_ROOT}"
[ -f "${INSTALL_ROOT}/env.offline" ] || cp "${INSTALL_ROOT}/env.offline.example" "${INSTALL_ROOT}/env.offline"
chmod +x "${INSTALL_ROOT}/kiosk/kiosk.sh" 2>/dev/null || true
if [ -f "${BUNDLE_DIR}/roboframe-bridge" ]; then
  # bridge source shipped alongside (from services/roboframe-bridge)
  cp -r "${BUNDLE_DIR}/roboframe-bridge/." "${BRIDGE_ROOT}/"
fi

echo "==> [3/6] Secrets"
if [ ! -f "${BRIDGE_ENV}" ]; then
  TOKEN=$(openssl rand -hex 24)
  cat > "${BRIDGE_ENV}" <<EOF
ROBOFRAME_BRIDGE_TOKEN=${TOKEN}
EOF
  chmod 600 "${BRIDGE_ENV}"
  echo "    bridge token written to ${BRIDGE_ENV} — note it down for the n8n credential"
fi
if grep -q '__FILL_ME__' "${INSTALL_ROOT}/env.offline"; then
  KEY=$(openssl rand -hex 24)
  sed -i.bak "s/__FILL_ME__/${KEY}/" "${INSTALL_ROOT}/env.offline"
  echo "    generated N8N_ENCRYPTION_KEY — back up ${INSTALL_ROOT}/env.offline NOW"
fi

echo "==> [4/6] Bridge venv (offline wheels expected in bundle)"
if [ -d "${BRIDGE_ROOT}" ] && [ ! -x "${BRIDGE_ROOT}/.venv/bin/roboframe-bridge" ]; then
  python3 -m venv "${BRIDGE_ROOT}/.venv"
  # Offline: wheels must have been pre-downloaded into the bundle.
  if [ -d "${BUNDLE_DIR}/wheels" ]; then
    "${BRIDGE_ROOT}/.venv/bin/pip" install --no-index --find-links "${BUNDLE_DIR}/wheels" "${BRIDGE_ROOT}"
  else
    echo "    WARNING: no wheels/ in bundle — install bridge deps online once:"
    echo "      ${BRIDGE_ROOT}/.venv/bin/pip install -e ${BRIDGE_ROOT}"
  fi
fi

echo "==> [5/6] systemd units"
sed "s|/opt/IB_Robot|${IB_ROBOT_DIR}|g; s|/opt/roboframe-bridge|${BRIDGE_ROOT}|g" \
  "${INSTALL_ROOT}/systemd/roboframe-bridge.service" > /etc/systemd/system/roboframe-bridge.service
cp "${INSTALL_ROOT}/systemd/n8n-rk3588.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now roboframe-bridge.service
systemctl enable --now n8n-rk3588.service

echo "==> [6/6] Kiosk autostart (current desktop user)"
DESKTOP_USER="${SUDO_USER:-$USER}"
AUTOSTART="/home/${DESKTOP_USER}/.config/autostart"
mkdir -p "${AUTOSTART}"
sed "s|/opt/n8n-rk3588/kiosk/kiosk.sh|${INSTALL_ROOT}/kiosk/kiosk.sh|" \
  "${INSTALL_ROOT}/kiosk/autostart-kiosk.desktop" > "${AUTOSTART}/n8n-kiosk.desktop"
chown "${DESKTOP_USER}" "${AUTOSTART}/n8n-kiosk.desktop"

echo ""
echo "Health checks:"
echo "  systemctl status roboframe-bridge --no-pager"
echo "  curl -s http://127.0.0.1:8090/v1/health"
echo "  curl -s http://127.0.0.1:5678/healthz"
echo "Kiosk starts at next login (or: ${INSTALL_ROOT}/kiosk/kiosk.sh &)."
