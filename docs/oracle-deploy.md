# Oracle Cloud (Always Free) deploy

Replaces Railway (trial credit ends ~1 Oct 2026). Zero cost: only Always Free resources.

## Tenancy facts (eu-madrid-1, single AD `sDgu:EU-MADRID-1-AD-1`)
- Service limits on this tenancy: **A1.Flex 2 OCPU / 12 GB total**, **E2.1.Micro ×2**, VCNs **2/2 used**
  (`sinalia-vcn`, `coleta-robobet-vcn`, owned by other projects), block storage 200 GB (boot volumes count).
- Other projects plan VMs here too: `sinalia-vm` (A1 2/12 → 1/6 → E2 micro, retry loop in
  `/workspace/oci/retry_loop.sh`) and `coleta-robobet` (A1 1/6). Leave their resources alone.
- SuperScore uses: subnet `sinalia-public` (no changes to it) + its own NSG `superscore-nsg`
  (ingress 22/80/443, all egress). IDs in `/workspace/oci/superscore_net.env`.
- VM launch: `/workspace/oci/superscore_launch.sh` (one attempt, recomputes headroom first, only
  A1 1 OCPU/6 GB or E2.1.Micro, 50 GB boot) and `/workspace/oci/superscore_retry.sh` (loop over
  fault domains, log `/workspace/oci/superscore_retry.log`). Madrid is frequently "Out of host capacity".
- SSH key: `/workspace/oci/ssh/superscore_vm` (user `ubuntu`). VM IP in `/workspace/oci/superscore_vm_ip`.

## Layout on the VM
- `/opt/superscore/releases/<sha>/` (dist, dist-server, prod node_modules), `/opt/superscore/current` → active release
- `/var/lib/superscore/data` (JSON store; each release has `data` → this symlink; DATA_DIR unset)
- `/etc/superscore/superscore.env` (600, secrets + flags; never committed). Copied from Railway vars
  minus `RAILWAY_RUN_UID`, plus `PUBLIC_URL=https://<ip-dashes>.sslip.io` (Telegram deep links + webhook).
- `superscore.service` (node 22, `Restart=always`, PORT 8080 on localhost; host firewall only opens 22/80/443)
- `superscore-watchdog.timer` → `/usr/local/bin/superscore-watchdog.sh` (restart if poller enabled and
  `lastTickAt` > 180 s old, or status endpoint down)
- Caddy on 80/443 → 127.0.0.1:8080, free Let's Encrypt cert for `<ip-dashes>.sslip.io`
- 2 GB swapfile on the boot volume

## Deploy a new commit (from the box)
```bash
cd /workspace/superscore-src
deploy/oracle/oracle-deploy.sh <commit>            # build clean git archive, ship, restart
deploy/oracle/oracle-deploy.sh <commit> --bootstrap # first time / re-run VM setup
```
Logs: `ssh -i /workspace/oci/ssh/superscore_vm ubuntu@$(cat /workspace/oci/superscore_vm_ip) journalctl -u superscore -f`
Counts: `node deploy/oracle/data-counts.mjs <dataDir>` (works on Railway `/app/data` and VM).

## Flags
`POLLER_ENABLED` and `TELEGRAM_ENABLED` in the env file. Never have two live pollers with Telegram on
(Railway + VM). Railway rollback = set `POLLER_ENABLED=1 TELEGRAM_ENABLED=1` there *after* stopping the VM
(`sudo systemctl stop superscore superscore-watchdog.timer`), then restore the latest data.

## Helpers
- Railway CLI wrapper `/tmp/rw` (recreate if missing):
  `#!/bin/sh` / `exec env -u RAILWAY_TOKEN RAILWAY_API_TOKEN="${RAILWAY_API_TOKEN:-$RAILWAY_TOKEN}" /home/box/.local/bin/railway "$@"`
  Run from `/workspace/superscore-src` (linked to project e2d680a2…, service `web` 9b9dc998…).
- Railway source disconnect (planned at cutover): `/tmp/rw service source disconnect --service web`.
- Final data snapshot from Railway: `/tmp/rw ssh -- tar -C /app -czf - data > data-final.tgz` then sha256 both sides.

## Status (2026-09-26 22:50 PT)
VM **not created yet**: A1.Flex and E2.1.Micro both return "Out of host capacity" in eu-madrid-1
(all 3 fault domains, since ~10:50 PT for the sinalia loop too). Railway remains production.
The retry loop keeps trying; once `superscore-vm` exists: record its IP in
`/workspace/oci/superscore_vm_ip`, run `oracle-deploy.sh f0217dc --bootstrap`, write the env file, dry run
with POLLER_ENABLED=1 TELEGRAM_ENABLED=0 (Telegram off
on the VM while Railway keeps Telegram on (duplicate *ticks* are fine, duplicate *sends* are not; the VM's
data dir is separate)). Then cut over per the plan.
