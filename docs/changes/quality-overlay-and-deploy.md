# Quality overlay + POLLER_ENABLED + Railway volume deploy (26/set/2026)

Branch `feat/quality-overlay-deploy` (from `fix/both-markets-telegram-retry`).
Locked rules, thresholds, windows, lead gate and lock are unchanged.

## Commits

1. `store: markAlertPushed finds goals FT alerts`: bookkeeping bug. Goals
   always read `alerts.json` (HT), so delivered goals FT alerts never got
   `sentPush` (production: 22 goals FT alerts with a Telegram message id, 0
   with `sentPush`).
2. `config: POLLER_ENABLED accepts 0/false/off`: before this, only `0` turned
   the poller off. Now `0/false/off/no/disabled` all work, for `POLLER_ENABLED`
   and `TELEGRAM_ENABLED`. With the poller off there are no ticks, fetches,
   Telegram sends or poller data writes.
3. `overlay: quality-filter rules…`: pure rules (`src/lib/qualityOverlay.ts`),
   the `AlertOverlay` type, the sticky first decision on upsert, and server
   helpers (`server/qualityOverlay.ts`).
4. `poller: quality overlay gates Telegram/push…`
5. `api+docs: overlay stats…`
6. `store: skip no-op alert store rewrites`: performance fix, see below.

## Overlay (QUALITY_OVERLAY=on|off, default on)

The overlay only decides which Primary alerts are notified. Every alert is
still generated, stored, settled and learned from. It carries
`overlay: {version:'q1-2026-09-26', pass, reasons[], enforced, notified}`.

| Scope | Notify only if |
|---|---|
| Corners HT | minute ≤ 38 |
| Goals HT | \|v\| ≥ 85 and (\|Δ1\| ≥ 70 or Sustained \|v\|≥30 ×4) and \|goal diff\| ≤ 1 |
| FT goals / FT corners | the pressing side (the alert side, i.e. the sign of the momentum) is not winning. If the side is unknown the alert is blocked with reason `side-unknown`. |
| All | at most 1 notified alert per match × market × half |

- **Same metrics as the locked Primary.** `momentum` = point value, `delta1` =
  the Δ1 of the point, and `sustainedLength` = the run length at the locked
  `sustainedThreshold` (30 for goals).
- **Score source.** The score is `goalsTally` at the alert minute, taken from
  the momentum feed events (the same source as the "Golos 1-0" line in the
  message).
- **When the decision is made.** The overlay decides at claim time, after the
  unchanged lead gate and notify flags.
- **Blocked alerts.** A blocked alert consumes its sent key, so it is decided
  once and not re-logged on every tick.
- **The cap.** It counts stored alerts with `overlay.pass && overlay.notified`
  in the per-market/half file, so it survives restarts. `notified` means
  "claimed for notification", not "delivered". If a send fails for good, that
  alert still uses up the half's slot. This avoids a second message in the
  same half while a retry for the first one is still pending.
- **`QUALITY_OVERLAY=off`.** Alerts are sent exactly as before, and the
  decision is still stored so the two can be compared.
- **Message header.** Alerts that pass get a `✅ Filtro` line under the
  Telegram title. Push copy is unchanged.
- **API.**
  - `GET /api/learn/overlay` returns, per market × half: base / overlayPass /
    delivered / overlayNotified with alerts, settled, won (GREEN = `hit5` or
    `hitLong`) and precision, plus counts per block reason.
  - `GET /api/learn/summary` gains a `qualityOverlay` block.
  - `GET /api/learn/alerts?market=&half=&overlay=pass|block&fixture=&limit=`
    lists alerts with their decision.
  - Alerts stored before the overlay existed are counted as
    `legacyWithoutOverlay`.

### Replay: 12 real fixtures, per-minute ticks, offline

These are the same 12 production snapshots as before, replayed as new
fixtures with one tick per minute (20–45 and 46–90) and then settled at full
time.

| Scope | Base sends (won/settled) | Overlay sends (won/settled) |
|---|---|---|
| Goals HT | 5 (2/5) | 2 (1/2) |
| Goals FT | 3 (2/3) | 2 (1/2) |
| Corners HT | 38 (8/38) | 9 (2/9) |
| Corners FT | 1 (0/1) | 0 |
| **Total** | **47 (12 GREEN, 25.5 %)** | **13 (4 GREEN, 30.8 %)** |

The sample is far too small to judge precision; compare with
`/api/learn/overlay` once production has run for a while.

## Tick time (both markets)

With corners evaluated every tick, production ticks went from about 3 s
(goals only) to 17–24 s. That is more than the 15 s interval, and some
fixtures hit the 12 s per-fixture timeout.

The cause was already in the code: each in-window match's full alert list is
re-ingested on every tick (and again after the odds attach), and
`upsertAlerts` rewrote the whole per-half store even when only `ts` changed.
`alerts_corners_ht.json` is about 12 MB.

Merges where only `ts` would change now skip the write. Results:

- Local replay with production-size stores: 6.2 s → 3.3 s, with identical
  sends.
- Production after the deploy: 7–12 s per tick.

`LoggedAlert.ts` is display-only. It now changes only when something real in
the alert changes.

## Deploy (Railway, see the report for times)

Backups are in `/workspace/superscore-recovered/raw/data-20260926-2114*.tgz`
(sha256 files alongside).

1. Stage `POLLER_ENABLED=0`, `TELEGRAM_ENABLED=0`, `RAILWAY_RUN_UID=0` and
   `QUALITY_OVERLAY=on`, skipping deploys.
2. Take a fresh backup of `/app/data` (tgz, sha256, and a JSON parse of all
   1606 files).
3. Create volume `web-data` (500 MB, the Trial maximum) mounted at `/app/data`.
4. Redeploy. The old code comes up with the poller and Telegram off and the
   volume empty.
5. Run `railway up` for the new code from a `git archive`: no `.git`, `data`,
   `node_modules`, `dist` or `.env`.
6. Restore the backup into the volume over `railway ssh` and check sha256 per
   file.
7. Set `POLLER_ENABLED=1` and `TELEGRAM_ENABLED=1`, then redeploy.
8. Deploy the performance fix.

`RAILWAY_RUN_UID=0` is needed because the Dockerfile image runs as `node`
and Railway volumes are owned by root (per Railway's docs).
