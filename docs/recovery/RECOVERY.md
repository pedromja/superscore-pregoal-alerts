# Recovery of `superscore-pregoal-alerts` source at `eaa7acb`

Target: commit `eaa7acb` (Merge PR #16 `notify-min-lead`), the build running in production.
Recovered on 2026-09-26 on the local box only (no cloud agents, no paid/external services, no remotes).
This is a faithful recovery, not a redesign: no features, refactors or behaviour changes.

## Result in one paragraph

Every file of the eaa7acb tree was rebuilt (94 tracked files, excluding `docs/recovery/`).
Rebuilding the server with the exact `build:server` esbuild command gives a **byte-identical**
`dist-server/index.mjs` (sha256 `4f0f2f9e…bbb5ec`, same as production). `npm run build` gives a
**byte-identical `dist/`** (`diff -r` against production is clean; `index-Bj_nL-0z.js`, `index-BEm6yIKq.css`,
all public assets). `package.json` and `package-lock.json` are byte-identical to production.
Two generated JSON artefacts were never fully visible in any transcript and are **not recovered** (see below).

## Sources

| Source | Use |
|---|---|
| `/workspace/superscore-pregoal-alerts` git, commit `361fb61` | exact base (all file bytes, incl. binary icons) |
| 18 cloud-agent transcripts (`/workspace/cloud-agent-transcripts/`, map below) | full-file reads, `search_replace` diffs, git command outputs |
| production image files (`/workspace/superscore-recovered/built/`: `dist-server/index.mjs`, `dist/`, `package.json`, `package-lock.json`) | verification target; lockfile copied verbatim |
| `src-from-bundle/` (esbuild module comments) | cross-check of server module list |

Transcript → PR: c7c3581c initial build (base), 26693045 #1, 86af8d39 #2, 09088a30 #3, 0bb4e7e2 #4,
60485e9f #5, 1f942abc #6, 723cf97d #7, 020c5d45 #8+#9, 9055c7c9 #10, dcf5feb5 #11, aca9ad87 #12,
a14c85a5 #13, 778479f4 #14, a6b60792 #15, 565e8892 #16 (= eaa7acb), b3a45416 #17 (not applied), 8670f2a4 clock-revalidation branch (reads only).

## Method

1. **Anchor** at base `361fb61` (git objects).
2. **Chain replay** PR #1 … #16 in merge order, each PR starting from its real parent state. Within a PR, every
   complete full-file read (`contents` lines == `totalLines`) replaces the working copy (authoritative); every
   recorded `search_replace` edit is applied from its unified diff (new files from the `+` lines). Branch resets
   (`git reset`/checkout) in the transcripts are honoured. The two rebases with conflicts (#7, #12) were replayed
   with real `git rebase` using the original commit contents so the agents' conflict-resolution edits apply exactly.
3. **Overlay eaa7acb reads**: full reads made in PR #17 before its first edit, and in the clock-revalidation
   transcript before its pull, are the eaa7acb state and override the replay (16 files; all already matched).
4. **Production cross-check**: server (+ the `src/lib` files it imports) via esbuild rebuild; frontend via `vite build`.
   No conflicts had to be resolved — both outputs were byte-identical without manual fixes.
5. `<REDACTED>` markers were never materialised; the tree contains env var names only (`.env.example` is the
   eaa7acb file verbatim: names/defaults, no secrets). A secret scan of the tree is clean.

## Verification results

- `npm ci` OK (Node v20.19.2 on the box; only EBADENGINE warnings).
- `npx tsc -b` (typecheck) exit 0. `oxlint` exit 0 (warnings only, as in the original).
- `npm run build` exit 0 → `dist/` byte-identical to production.
- `build:server` (exact command, pinned esbuild 0.28.2) → `dist-server/index.mjs` byte-identical to production.
- `npm test` exit 0, all 10 scripts OK: robobet, windows, overlay, poller, notify, sokkerpro, delivery, lock,
  telegram, notify-lead (run offline under `unshare -rn`, so no Telegram/SokkerPro/network calls were possible).
- Per-commit `git show --stat` / `git diff --stat` outputs recorded in the transcripts were compared with the
  reconstruction: file lists, insertions and deletions match exactly for #1, #4–#8, #9 (cached stat), #10, #11,
  #12, #13, #14, #15, #16 (8 files, +567/−4) and #17 (14 files, +1283/−32). The only mismatches are fully
  explained: an intermediate `server/store.ts` state inside #2/#3 (healed by a later full read; final file is
  bundle-verified) and the two unrecovered JSON artefacts.
- eaa7acb `totalLines` known from #17/#18 partial reads matches for all 33 files where it is known, with zero
  mismatching chunks among ~460 partial reads.
- 25 edits in the transcripts have no recorded result; every affected commit's diffstat still matches exactly,
  so none of them left an unaccounted change.

## Not recovered

- `backtest-data/backtest-results.json` and `docs/backtest-2026-09-18.json` — identical generated output of
  `scripts/backtest-lead.ts` (496 lines, 14 109 B in the original). Never read in full. Not referenced by any
  code, build or test. They can be regenerated with the backtest script, but the output depends on the live
  data at run time, so it will not be byte-identical.

## PR #17 (kept out)

PR #17 (`fast-live-score-gate`, merged as `a10f788`, never deployed) is **not applied**. Its diff is saved as
`docs/recovery/pr17-fast-live-score-gate.patch` (14 files, +1283/−32, matches the original stat;
`git apply --check` passes on this tree).

## Confidence per file

- **verbatim** (57): bytes proven by a complete read at/after the last change, by the base git
  object, or by a production artefact.
- **reconstructed (output-verified)** (23): replayed; runtime code proven by byte-identical
  server bundle / `dist/`. Comments and type-only code are erased by the build, so those come from the
  replay (tsc passes; diffstats match).
- **reconstructed (replay-only)** (14): docs, config and test scripts that are
  not in any build output. Evidence is the replay, matching diffstats, eaa7acb line counts where known, and the
  tests passing. This is the lowest-confidence group:
  `README.md`, `backtest-data/BACKTEST.md`, `data/tip_overlay.json`, `render.yaml`, `scripts/backtest-lead.ts`, `scripts/dump-backtest-matches.ts`, `scripts/dump-backtest-sample.ts`, `scripts/verify-corner-windows.ts`, `scripts/verify-lock-lead.ts`, `scripts/verify-notify-lead.ts`, `scripts/verify-poller-health.ts`, `scripts/verify-sokkerpro.ts`, `scripts/verify-telegram.ts`, `scripts/verify-tip-overlay.ts`.

| File | Confidence | Source | Extra verification |
|---|---|---|---|
| `.dockerignore` | verbatim | unchanged since 361fb61 (git object) | — |
| `.env.example` | verbatim | = full read at eaa7acb (#17 pre-edit / #18 pre-pull) | eaa7acb lines=45, 100% seen |
| `.gitignore` | verbatim | = full read at eaa7acb (#17 pre-edit / #18 pre-pull) | eaa7acb lines=36, 100% seen |
| `.oxlintrc.json` | verbatim | unchanged since 361fb61 (git object) | — |
| `Dockerfile` | verbatim | unchanged since 361fb61 (git object) | — |
| `README.md` | reconstructed (replay-only) | full read PR #4 + 42 recorded edit(s) through PR #15 | eaa7acb lines=311, 25% seen |
| `backtest-data/BACKTEST.md` | reconstructed (replay-only) | full read PR #12 + 2 recorded edit(s) through PR #12 | — |
| `data/.gitkeep` | verbatim | unchanged since 361fb61 (git object) | — |
| `data/tip_overlay.json` | reconstructed (replay-only) | full read PR #4 + 1 recorded edit(s) through PR #4 | — |
| `docs/backtest-2026-09-18.md` | verbatim | = full read at eaa7acb (#17 pre-edit / #18 pre-pull) | eaa7acb lines=85, 100% seen |
| `index.html` | verbatim | unchanged since 361fb61 (git object) | dist/ byte-identical |
| `package-lock.json` | verbatim | byte copy of production /app/package-lock.json | — |
| `package.json` | verbatim | = production /app/package.json = eaa7acb read (#17) | eaa7acb lines=57, 100% seen |
| `public/demo/celtic-ferenc-momentum.json` | verbatim | unchanged since 361fb61 (git object) | dist/ byte-identical |
| `public/demo/drava-bistrica-momentum.json` | verbatim | = full read at eaa7acb (#17 pre-edit / #18 pre-pull) | dist/ byte-identical; eaa7acb lines=1, 100% seen |
| `public/favicon.svg` | verbatim | unchanged since 361fb61 (git object) | dist/ byte-identical |
| `public/icons/apple-touch-icon.png` | verbatim | unchanged since 361fb61 (git object) | dist/ byte-identical |
| `public/icons/icon-192.png` | verbatim | unchanged since 361fb61 (git object) | dist/ byte-identical |
| `public/icons/icon-512.png` | verbatim | unchanged since 361fb61 (git object) | dist/ byte-identical |
| `public/manifest.webmanifest` | verbatim | unchanged since 361fb61 (git object) | dist/ byte-identical |
| `public/sw.js` | verbatim | unchanged since 361fb61 (git object) | dist/ byte-identical |
| `railway.toml` | verbatim | unchanged since 361fb61 (git object) | — |
| `render.yaml` | reconstructed (replay-only) | full read PR #15 + 1 recorded edit(s) through PR #15 | — |
| `scripts/backtest-lead.ts` | reconstructed (replay-only) | created PR #12 + 1 recorded edit(s) through PR #12 | — |
| `scripts/dump-backtest-matches.ts` | reconstructed (replay-only) | created PR #12 + 1 recorded edit(s) through PR #12 | eaa7acb lines=193, 100% seen |
| `scripts/dump-backtest-sample.ts` | reconstructed (replay-only) | created PR #12 + 1 recorded edit(s) through PR #12 | — |
| `scripts/verify-corner-windows.ts` | reconstructed (replay-only) | full read PR #12 + 8 recorded edit(s) through PR #15 | — |
| `scripts/verify-lock-lead.ts` | reconstructed (replay-only) | full read PR #16 + 2 recorded edit(s) through PR #16 | eaa7acb lines=251, 20% seen |
| `scripts/verify-notification-copy.ts` | verbatim | = full read in PR #13 after its last edit | eaa7acb lines=94, 86% seen |
| `scripts/verify-notify-lead.ts` | reconstructed (replay-only) | created PR #16 + 3 recorded edit(s) through PR #16 | eaa7acb lines=428, 18% seen |
| `scripts/verify-odds-delivery.ts` | verbatim | = full read in PR #16 after its last edit | eaa7acb lines=246, 100% seen |
| `scripts/verify-poller-health.ts` | reconstructed (replay-only) | full read PR #11 + 15 recorded edit(s) through PR #15 | eaa7acb lines=813, 60% seen |
| `scripts/verify-robobet-parser.ts` | verbatim | = full read in PR #8 after its last edit | — |
| `scripts/verify-sokkerpro.ts` | reconstructed (replay-only) | created PR #8 + 4 recorded edit(s) through PR #8 | — |
| `scripts/verify-telegram.ts` | reconstructed (replay-only) | created PR #13 + 13 recorded edit(s) through PR #14 | eaa7acb lines=690, 34% seen |
| `scripts/verify-tip-overlay.ts` | reconstructed (replay-only) | full read PR #8 + 1 recorded edit(s) through PR #12 | — |
| `server/config.ts` | verbatim | = full read at eaa7acb (#17 pre-edit / #18 pre-pull) | server bundle byte-identical; eaa7acb lines=180, 100% seen |
| `server/index.ts` | reconstructed (output-verified) | full read PR #4 + 27 recorded edit(s) through PR #14 | server bundle byte-identical |
| `server/learn.ts` | reconstructed (output-verified) | base 361fb61 + 45 recorded edit(s) through PR #14 | server bundle byte-identical; eaa7acb lines=855, 49% seen |
| `server/odds.ts` | verbatim | = full read in PR #10 after its last edit | server bundle byte-identical |
| `server/poller.ts` | reconstructed (output-verified) | full read PR #10 + 55 recorded edit(s) through PR #16 | server bundle byte-identical |
| `server/pollerHealth.ts` | reconstructed (output-verified) | full read PR #15 + 2 recorded edit(s) through PR #15 | server bundle byte-identical |
| `server/push.ts` | verbatim | = full read in PR #13 after its last edit | server bundle byte-identical |
| `server/sokkerpro.ts` | verbatim | = full read at eaa7acb (#17 pre-edit / #18 pre-pull) | server bundle byte-identical; eaa7acb lines=282, 100% seen |
| `server/ss.ts` | verbatim | = full read at eaa7acb (#17 pre-edit / #18 pre-pull) | server bundle byte-identical; eaa7acb lines=142, 100% seen |
| `server/store.ts` | reconstructed (output-verified) | full read PR #4 + 24 recorded edit(s) through PR #14 | server bundle byte-identical; eaa7acb lines=622, 59% seen |
| `server/telegram.ts` | reconstructed (output-verified) | full read PR #14 + 10 recorded edit(s) through PR #14 | server bundle byte-identical |
| `server/telegramOutcomes.ts` | verbatim | = full read in PR #14 after its last edit | server bundle byte-identical |
| `server/telegramResolve.ts` | reconstructed (output-verified) | created PR #14 + 3 recorded edit(s) through PR #14 | server bundle byte-identical |
| `server/telegramUpdates.ts` | reconstructed (output-verified) | created PR #14 + 2 recorded edit(s) through PR #14 | server bundle byte-identical |
| `server/tips.ts` | reconstructed (output-verified) | full read PR #4 + 18 recorded edit(s) through PR #10 | server bundle byte-identical |
| `server/types.ts` | verbatim | = full read at eaa7acb (#17 pre-edit / #18 pre-pull) | eaa7acb lines=158, 100% seen |
| `server/vapid-generate.ts` | verbatim | unchanged since 361fb61 (git object) | — |
| `src/App.tsx` | reconstructed (output-verified) | full read PR #12 + 5 recorded edit(s) through PR #12 | dist/ byte-identical |
| `src/components/AlertCard.tsx` | reconstructed (output-verified) | full read PR #12 + 4 recorded edit(s) through PR #12 | dist/ byte-identical |
| `src/components/MarketToggle.tsx` | verbatim | = full read in PR #12 after its last edit | dist/ byte-identical |
| `src/components/MomentumChart.tsx` | verbatim | unchanged since 361fb61 (git object) | dist/ byte-identical |
| `src/components/NotificationBar.tsx` | reconstructed (output-verified) | base 361fb61 + 10 recorded edit(s) through PR #13 | dist/ byte-identical |
| `src/components/TelegramStatusNote.tsx` | reconstructed (output-verified) | created PR #13 + 1 recorded edit(s) through PR #13 | dist/ byte-identical |
| `src/index.css` | verbatim | unchanged since 361fb61 (git object) | dist/ byte-identical |
| `src/lib/api.ts` | verbatim | = full read in PR #13 after its last edit | server bundle byte-identical; eaa7acb lines=121, 32% seen |
| `src/lib/demos.ts` | verbatim | = full read in PR #12 after its last edit | dist/ byte-identical |
| `src/lib/format.ts` | verbatim | unchanged since 361fb61 (git object) | server bundle byte-identical |
| `src/lib/horizons.ts` | verbatim | = full read at eaa7acb (#17 pre-edit / #18 pre-pull) | server bundle byte-identical; eaa7acb lines=191, 100% seen |
| `src/lib/learnApi.ts` | reconstructed (output-verified) | full read PR #12 + 3 recorded edit(s) through PR #15 | dist/ byte-identical; eaa7acb lines=301, 26% seen |
| `src/lib/lock.ts` | verbatim | = full read at eaa7acb (#17 pre-edit / #18 pre-pull) | server bundle byte-identical; eaa7acb lines=19, 100% seen |
| `src/lib/market.ts` | reconstructed (output-verified) | full read PR #12 + 3 recorded edit(s) through PR #12 | server bundle byte-identical; eaa7acb lines=242, 63% seen |
| `src/lib/monitorStore.ts` | verbatim | = full read in PR #3 after its last edit | dist/ byte-identical |
| `src/lib/notifications.ts` | verbatim | = full read in PR #16 after its last edit | server bundle byte-identical; eaa7acb lines=110, 100% seen |
| `src/lib/notifyLead.ts` | verbatim | = full read at eaa7acb (#17 pre-edit / #18 pre-pull) | server bundle byte-identical; eaa7acb lines=101, 100% seen |
| `src/lib/oddsMarkets.ts` | verbatim | = full read in PR #8 after its last edit | server bundle byte-identical |
| `src/lib/oddsObserve.ts` | verbatim | = full read in PR #10 after its last edit | server bundle byte-identical |
| `src/lib/pushRemote.ts` | verbatim | = full read in PR #2 after its last edit | dist/ byte-identical |
| `src/lib/robobet.ts` | verbatim | = full read in PR #4 after its last edit | server bundle byte-identical |
| `src/lib/rules.ts` | reconstructed (output-verified) | full read PR #2 + 13 recorded edit(s) through PR #12 | server bundle byte-identical; eaa7acb lines=468, 62% seen |
| `src/lib/settings.ts` | verbatim | = full read in PR #12 after its last edit | dist/ byte-identical |
| `src/lib/sokkerpro.ts` | reconstructed (output-verified) | created PR #8 + 4 recorded edit(s) through PR #8 | server bundle byte-identical |
| `src/lib/tally.ts` | verbatim | = full read at eaa7acb (#17 pre-edit / #18 pre-pull) | server bundle byte-identical; eaa7acb lines=131, 100% seen |
| `src/lib/tipOverlay.ts` | verbatim | = full read in PR #8 after its last edit | server bundle byte-identical |
| `src/lib/tips.ts` | reconstructed (output-verified) | full read PR #8 + 1 recorded edit(s) through PR #8 | server bundle byte-identical; eaa7acb lines=226, 100% seen |
| `src/lib/tipsApi.ts` | verbatim | = full read in PR #8 after its last edit | dist/ byte-identical |
| `src/lib/types.ts` | verbatim | = full read at eaa7acb (#17 pre-edit / #18 pre-pull) | dist/ byte-identical; eaa7acb lines=188, 100% seen |
| `src/lib/windows.ts` | verbatim | = full read in PR #16 after its last edit | server bundle byte-identical; eaa7acb lines=204, 100% seen |
| `src/main.tsx` | verbatim | unchanged since 361fb61 (git object) | dist/ byte-identical |
| `src/pages/LearningPage.tsx` | reconstructed (output-verified) | base 361fb61 + 30 recorded edit(s) through PR #12 | dist/ byte-identical |
| `src/pages/MonitorPage.tsx` | reconstructed (output-verified) | base 361fb61 + 39 recorded edit(s) through PR #16 | dist/ byte-identical; eaa7acb lines=519, 5% seen |
| `src/pages/ReplayPage.tsx` | reconstructed (output-verified) | base 361fb61 + 18 recorded edit(s) through PR #12 | dist/ byte-identical |
| `src/pages/SettingsPage.tsx` | reconstructed (output-verified) | full read PR #2 + 15 recorded edit(s) through PR #13 | dist/ byte-identical |
| `src/pages/TipsPage.tsx` | reconstructed (output-verified) | full read PR #4 + 18 recorded edit(s) through PR #13 | dist/ byte-identical |
| `tsconfig.app.json` | verbatim | unchanged since 361fb61 (git object) | — |
| `tsconfig.json` | verbatim | = full read at eaa7acb (#17 pre-edit / #18 pre-pull) | eaa7acb lines=8, 100% seen |
| `tsconfig.node.json` | verbatim | unchanged since 361fb61 (git object) | — |
| `vercel.json` | verbatim | unchanged since 361fb61 (git object) | — |
| `vite.config.ts` | verbatim | = full read in PR #14 after its last edit | — |
