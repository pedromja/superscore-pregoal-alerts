#!/bin/bash
# One-time setup of the Oracle Always Free VM (run as root on the VM; idempotent).
# Usage: sudo bash bootstrap-vm.sh <public-ip>
set -euo pipefail
IP="$1"; HOST="$(echo "$IP" | tr . -).sslip.io"
export DEBIAN_FRONTEND=noninteractive
# Swap on the boot volume (2 GB; essential on E2.1.Micro 1 GB RAM, harmless on A1).
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -w vm.swappiness=10 >/dev/null; echo 'vm.swappiness=10' > /etc/sysctl.d/99-superscore.conf
fi
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg debian-keyring debian-archive-keyring apt-transport-https iptables-persistent >/dev/null
# Node 22 (same major as Dockerfile node:22-alpine)
if ! node -v 2>/dev/null | grep -q '^v22\.'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
# Caddy (free HTTPS reverse proxy)
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi
# Host firewall: Oracle Ubuntu images REJECT everything but 22 in INPUT. Open 80/443 only.
for p in 443 80; do
  iptables -C INPUT -p tcp -m state --state NEW -m tcp --dport $p -j ACCEPT 2>/dev/null || \
    iptables -I INPUT 5 -p tcp -m state --state NEW -m tcp --dport $p -j ACCEPT
done
netfilter-persistent save >/dev/null
# Service user + dirs
id superscore >/dev/null 2>&1 || useradd --system --home /opt/superscore --shell /usr/sbin/nologin superscore
mkdir -p /opt/superscore/releases /var/lib/superscore/data/matches /etc/superscore
chown -R superscore:superscore /var/lib/superscore
chmod 750 /etc/superscore
# Caddy site
sed -e "s/__HOST__/$HOST/g" -e "s/__IP__/$IP/g" /tmp/superscore-deploy/Caddyfile.tmpl > /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy
# Units
install -m 644 /tmp/superscore-deploy/superscore.service /etc/systemd/system/superscore.service
install -m 644 /tmp/superscore-deploy/superscore-watchdog.service /etc/systemd/system/superscore-watchdog.service
install -m 644 /tmp/superscore-deploy/superscore-watchdog.timer /etc/systemd/system/superscore-watchdog.timer
install -m 755 /tmp/superscore-deploy/superscore-watchdog.sh /usr/local/bin/superscore-watchdog.sh
systemctl daemon-reload
systemctl enable superscore superscore-watchdog.timer >/dev/null 2>&1
echo "bootstrap ok: node $(node -v), caddy $(caddy version | cut -d' ' -f1), https://$HOST"
