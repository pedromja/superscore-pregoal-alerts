#!/bin/bash
# Restart superscore if the poller is enabled but lastTickAt is older than MAX_AGE_S
# (mirrors the in-app tick watchdog, but from outside the process). Zero cost.
MAX_AGE_S=${MAX_AGE_S:-180}
systemctl is-active --quiet superscore || exit 0
up_s=$(( $(date +%s) - $(date -d "$(systemctl show -p ActiveEnterTimestamp --value superscore)" +%s 2>/dev/null || echo 0) ))
[ "$up_s" -lt 240 ] && exit 0
json=$(curl -fsS -m 10 http://127.0.0.1:8080/api/poller/status) || {
  logger -t superscore-watchdog "status endpoint down (up ${up_s}s) -> restart"; systemctl restart superscore; exit 0; }
age=$(printf '%s' "$json" | python3 -c '
import sys,json,datetime as d
j=json.load(sys.stdin)
if not j.get("enabled"): print(-1); sys.exit()
t=j.get("lastTickAt")
if not t: print(99999); sys.exit()
print(int((d.datetime.now(d.timezone.utc)-d.datetime.fromisoformat(t.replace("Z","+00:00"))).total_seconds()))')
if [ "${age:--1}" -gt "$MAX_AGE_S" ]; then
  logger -t superscore-watchdog "lastTickAt ${age}s old (> ${MAX_AGE_S}s) -> restart"; systemctl restart superscore
fi
