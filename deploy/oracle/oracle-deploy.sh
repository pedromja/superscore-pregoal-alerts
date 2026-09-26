#!/bin/bash
# Build a commit from the local repo (clean git archive) and ship it to the Oracle VM.
# Usage (from the box): deploy/oracle/oracle-deploy.sh [commit=HEAD] [--bootstrap]
#   --bootstrap  also (re)run the one-time VM setup (swap, Node 22, Caddy, firewall, units)
# Data (/var/lib/superscore/data) and secrets (/etc/superscore/superscore.env) are never touched.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
VM_IP="${VM_IP:-$(cat /workspace/oci/superscore_vm_ip 2>/dev/null)}"
KEY="${KEY:-/workspace/oci/ssh/superscore_vm}"
COMMIT="${1:-HEAD}"; BOOT=0; [ "${2:-}" = "--bootstrap" ] || [ "${1:-}" = "--bootstrap" ] && BOOT=1
[ "$COMMIT" = "--bootstrap" ] && COMMIT=HEAD
SHA="$(git -C "$REPO" rev-parse --short "$COMMIT")"
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 ubuntu@"$VM_IP")
B="$(mktemp -d)"; trap 'rm -rf "$B"' EXIT
echo "== build $SHA"
git -C "$REPO" archive "$SHA" | tar -x -C "$B"
(cd "$B" && npm ci --no-audit --no-fund >/dev/null && npm run build >/dev/null)
tar -czf "$B/release.tgz" -C "$B" package.json package-lock.json dist dist-server
echo "== ship to $VM_IP"
"${SSH[@]}" 'rm -rf /tmp/superscore-deploy && mkdir -p /tmp/superscore-deploy'
scp -i "$KEY" -q "$B/release.tgz" "$REPO"/deploy/oracle/{superscore.service,superscore-watchdog.*,Caddyfile.tmpl,bootstrap-vm.sh} ubuntu@"$VM_IP":/tmp/superscore-deploy/
[ "$BOOT" = 1 ] && "${SSH[@]}" "sudo bash /tmp/superscore-deploy/bootstrap-vm.sh $VM_IP"
"${SSH[@]}" "set -e; R=/opt/superscore/releases/$SHA; sudo rm -rf \$R; sudo mkdir -p \$R
  sudo tar -xzf /tmp/superscore-deploy/release.tgz -C \$R
  sudo ln -sfn /var/lib/superscore/data \$R/data
  sudo chown -R superscore:superscore \$R
  cd \$R && sudo -u superscore env HOME=/tmp npm ci --omit=dev --no-audit --no-fund >/dev/null
  sudo ln -sfn \$R /opt/superscore/current
  sudo install -m 644 /tmp/superscore-deploy/superscore.service /etc/systemd/system/superscore.service
  sudo systemctl daemon-reload
  if [ -f /etc/superscore/superscore.env ]; then sudo systemctl restart superscore; else echo 'no env file yet: not starting'; fi
  ls -1dt /opt/superscore/releases/* | tail -n +4 | xargs -r sudo rm -rf
  echo deployed $SHA"
sleep 8; "${SSH[@]}" 'systemctl is-active superscore; curl -fsS -m 10 http://127.0.0.1:8080/api/poller/status | head -c 400; echo' || true
