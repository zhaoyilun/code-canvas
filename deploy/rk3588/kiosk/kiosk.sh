#!/usr/bin/env bash
# Kiosk launcher: wait for n8n health, then open a fullscreen Chromium on the
# attached touchscreen. Called from the desktop autostart entry.
#
# Touch tuning notes:
#  --touch-events        always-on touch event delivery
#  --overscroll-history-navigation=0  no back-swipe accidents on the canvas
#  --noerrdialogs / --disable-infobars  kiosk must never show chrome UI
#  --check-for-update-interval=31536000  effectively disable update pings

set -euo pipefail

N8N_URL="${N8N_URL:-http://127.0.0.1:5678}"

# Wait up to 120 s for n8n (first boot runs migrations).
for _ in $(seq 1 120); do
  if wget -qO- "$N8N_URL/healthz" >/dev/null 2>&1; then break; fi
  sleep 1
done

# Never blank or sleep the touchscreen while the kiosk is up.
xset s off 2>/dev/null || true
xset -dpms 2>/dev/null || true
xset s noblank 2>/dev/null || true

# Hide the mouse cursor after idleness — on a touch panel it is noise.
if command -v unclutter >/dev/null 2>&1; then
  unclutter -idle 2 -root &
fi

exec chromium-browser \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --touch-events \
  --overscroll-history-navigation=0 \
  --check-for-update-interval=31536000 \
  --no-first-run \
  --no-default-browser-check \
  "$N8N_URL"
