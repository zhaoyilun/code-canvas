#!/usr/bin/env bash
# Build the offline deployment bundle on a build machine (any arm64 with the
# repo + docker; an Apple-silicon Mac works — same architecture as RK3588,
# no emulation). Produces:
#   bundle/n8n-rk3588-<tag>.tar.gz   (docker image, self-contained layers)
#   bundle/rk3588-files.tar.gz       (compose/systemd/kiosk/env files)
#   bundle/SHA256SUMS
#
# Transfer the whole bundle/ dir to the RK3588 via USB/SD, then run
# install.sh there.

set -euo pipefail
cd "$(dirname "$0")/../.."

TAG="${1:-$(git rev-parse --short HEAD)}"
BUNDLE="bundle"
IMAGE="n8n-rk3588:${TAG}"

echo "==> [1/4] Building n8n production tree (compiled/)"
pnpm build:n8n > /tmp/build-n8n.log 2>&1 || { tail -20 /tmp/build-n8n.log; exit 1; }

echo "==> [2/4] Building custom nodes (arch-independent JS)"
pnpm --filter n8n-nodes-blockly-code build > /tmp/build-node-blockly.log 2>&1 || { tail -20 /tmp/build-node-blockly.log; exit 1; }
pnpm --filter n8n-nodes-roboframe build > /tmp/build-node-roboframe.log 2>&1 || { tail -20 /tmp/build-node-roboframe.log; exit 1; }

echo "==> [3/4] Building docker image ${IMAGE}"
docker build -f deploy/rk3588/Dockerfile -t "${IMAGE}" .

echo "==> [4/4] Packing bundle"
mkdir -p "${BUNDLE}"
docker save "${IMAGE}" | gzip > "${BUNDLE}/n8n-rk3588-${TAG}.tar.gz"
tar -czf "${BUNDLE}/rk3588-files.tar.gz" \
  -C deploy/rk3588 docker-compose.yml env.offline.example systemd kiosk install.sh
( cd "${BUNDLE}" && shasum -a 256 * > SHA256SUMS 2>/dev/null || sha256sum * > SHA256SUMS )

echo ""
echo "Bundle ready in ${BUNDLE}/ (tag=${TAG}):"
ls -lh "${BUNDLE}"
echo ""
echo "Next: copy bundle/ to the RK3588 and run install.sh (see docs/roboframe/deploy-rk3588.md)."
