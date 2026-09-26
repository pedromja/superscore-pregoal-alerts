# fix/both-markets-telegram-retry

Branch from the recovered `eaa7acb` source (commit `129bc45`). PR #17 is **not** applied and no precision overlay has been added. No thresholds, windows, rules, lead gate (`MIN_NOTIFY_LEAD_MIN`) or locks (`DEFINITIONS_LOCKED`) were changed.

## Commits

1. **Market-unique alert and tip keys with a compatible reader** (`server/alertKeys.ts`, store/tips/telegram*)
2. **Poller evaluates goals and corners on every tick; the market toggle is view-only** (`server/poller.ts`, `/api/learn/market`)
3. **Telegram: bounded, lead-gated retry for transient send failures** (`server/telegramRetry.ts`, `server/telegram.ts`)
4. Docs (this file)

## Decisions

### Both markets
- `EVALUATED_MARKETS = ['goals', 'corners']`. Each market uses its own `currentSettings(market, half)` (the locked defaults), clock window, event type, primed key, sent keys, learning files and Telegram delivery. One `saveMatch` runs per fixture. Claims are serialised on the store lock, and the two markets' Telegram sends run concurrently.
- `data/market.json` and `PUT/POST /api/learn/market` still exist and keep their response shape. They now only store the UI view preference, which is also the default for API calls that omit `?market=`. The responses add `viewOnly: true`, `evaluatedMarkets` and a `note`.
- Fixture selection: in-window selection already covered any market's window. The corners pre-window priority boost (28–31′ / 78–81′) now always applies, because corners are always evaluated. This only affects the order of the out-of-window fill.
- A market's first sight of a live fixture still primes without pushing. At deploy, goals will prime any live match that had only been primed for corners.

### Keys
- The existing convention (`sentKey`, `primedKey`, push tags) is kept: **goals keys stay byte-for-byte legacy, corners keys are prefixed** (`corners:<fixture>:<alert>`, `tip-corners-<fixture>-<alert>`).
- `sent.json` and `primed.json` were already market-unique; the tests now assert this.
- `LoggedAlert.id` is **unchanged**. Learning stores are split per market+half file, so ids never collide there. Keeping the ids stable avoids duplicate learning rows for alerts that are live across the deploy.
- `telegram_messages.json`: new records carry `market`. Legacy records infer it from the text (`<b>Golo…` / `<b>Canto…`). A corners key falls back to its legacy unprefixed record only if that record is a corners one. `findLoggedAlert` honours an explicit prefix, or else the record's market. This fixes a real case found in the production state: `1ERahgfdCBILANABtA7gqP:primary-1-38-37` exists in both markets, and its corners GREEN/RED was resolved against the goals alert.
- If a new goals alert collides with a legacy corners record, the goals record never merges into it, and the legacy record is copied to `corners:<key>` so it stays resolvable.
- Known residual edge case: an *old* Telegram "Resolver agora" button (unprefixed callback) for a legacy corners alert, whose key a new goals alert later reuses, resolves to the goals alert. This needs the same match live across the deploy with the same minute/index.
- The UI deep link (`?alert=<fixture>:<alert>`) and the push `alertKey` are unchanged, because `MonitorPage` splits the key on `:`.

### Telegram retry
- **Retried:** network errors (`fetch failed`, DNS/connect/reset), HTTP 429 (waits Telegram's `retry_after`), and 5xx.
- **Final (not retried):** other 4xx, and timeouts. After `TELEGRAM_TIMEOUT_MS` the request has been fully sent and Telegram may have delivered it, so retrying risks a duplicate. Connection resets mid-response are retried; in rare cases that could still duplicate.
- **Budget:** backoff 2 s → 6 s → 18 s, at most 4 attempts in total, and no attempt starts later than 60 s after the first. These are configurable via `TELEGRAM_RETRY_MAX_ATTEMPTS`, `TELEGRAM_RETRY_BASE_MS` and `TELEGRAM_RETRY_MAX_AGE_MS`. A `retry_after` that goes past the budget means give up.
- **Lead expiry:** before every retry, the same `notifySuppressReason` used on the live path runs again on the latest stored snapshot (the poller saves one every tick). The retry is also dropped if the period changed, the match ended, or the alert has already been delivered. An alert whose event has already happened, or whose lead is under 1′, is therefore never delivered late. The 60 s cap bounds how far the match clock can move (about 1′).
- **No duplicates:** one retry chain per alert key (single-flight). The sent-key claim made before the first attempt still blocks re-claims on later ticks.
- **Latency:** the first attempt stays inline, so latency is unchanged. Retries run in the background and never block the tick or the per-fixture timeout.
- **Late delivery** does the same bookkeeping as an inline one: message id, `sentPush`, `alertsSent`, and a tip opened from the odds the attach step stored.
- **Restart:** a pending retry is lost on restart. The alert then stays claimed but undelivered, which is the same outcome as a failed send today.
- **Outcome notices:** GREEN/RED notices keep their existing best-effort claim/clear behaviour and are not retried here.
- **Monitoring:** counters are exposed at `/api/poller/status` → `telegram.retry`.

## Verification (offline, `unshare -rn`)
- `npm test`: all 13 scripts OK (the 10 existing scripts plus `test:market-keys`, `test:both-markets` and `test:telegram-retry`). `tsc -b`, `npm run build` and `oxlint` all pass, with 18 warnings, the same as the baseline.
- The ad-hoc strict typecheck of `server/` and `scripts/` (which `tsc -b` does not cover) shows 15 errors, all pre-existing: the baseline had 16 and one was fixed. No new errors.
- **Boot on a copy of the production state** (`superscore-recovered/state/data`, 1,576 matches, 39 MB): the server starts and every endpoint returns 200. That covers poller/telegram status, learn/market, learn summary for all four scopes (goals HT 540 / FT 352 alerts, corners HT 6,039 / FT 2,969), params, tips (1,512), observations, overlay and push status. The only file written was `vapid.json` (no VAPID env, the existing behaviour). With no network, the poller tick reports `lastError: fetch failed`.
- **Tick simulation on the same state**: 12 real match payloads replayed as new live fixtures, with the market view set to corners. The new code sends 7 goal + 39 corner alerts. The old code sends exactly 39 corner alerts in corners mode and exactly 7 goal alerts in goals mode, so the new output is precisely the union.
- **Tick time**: the average tick went from 5.1 s to 5.5 s. That time is dominated by the existing per-fixture rewrite of `alerts_corners_ht.json` (12 MB), which is a pre-existing cost and was not changed here.
