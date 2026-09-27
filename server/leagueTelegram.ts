import type { Market } from '../src/lib/types.ts'
import type { Tip } from '../src/lib/tips.ts'
import {
  DEFAULT_LEAGUE_TG_GATE,
  marketToTg,
  normalizeGate,
  normalizeLeagueTelegramFile,
  shouldSendTelegramLeague,
  type LeagueTelegramFile,
  type LeagueTgGate,
  type LeagueTgMarket,
} from '../src/lib/leagueTelegram.ts'
import { addToFlatAgg, emptyFlatAgg, finishFlatAgg } from '../src/lib/tipPnl.ts'
import { resolveFixtureLeague } from './competitions.ts'
import { loadLeagueTelegram, loadTips, saveLeagueTelegram } from './store.ts'

export function getLeagueTelegramFile(): LeagueTelegramFile {
  return loadLeagueTelegram()
}

export function patchLeagueTelegramGate(args: {
  key: string
  market: LeagueTgMarket | Market
  tg?: boolean
  auto?: boolean
  minRoi?: number
}): LeagueTelegramFile {
  const file = loadLeagueTelegram()
  const m = marketToTg(args.market)
  const prev = file.leagues[args.key]?.[m] ?? { ...DEFAULT_LEAGUE_TG_GATE }
  const next = normalizeGate({
    ...prev,
    ...(args.tg !== undefined ? { tg: args.tg } : {}),
    ...(args.auto !== undefined ? { auto: args.auto } : {}),
    ...(args.minRoi !== undefined ? { minRoi: args.minRoi } : {}),
  })
  file.leagues[args.key] = {
    ...file.leagues[args.key],
    [m]: next,
  }
  saveLeagueTelegram(file)
  return file
}

/**
 * Flat 1u stake, pnl derived from odd + status (tipPnl.ts); tips without a
 * valid odd are left out, so `settled` = settled tips with a valid odd.
 */
function marketRoi(tips: Tip[], key: string, market: LeagueTgMarket): {
  settled: number
  roi: number | null
} {
  const agg = emptyFlatAgg()
  for (const tip of tips) {
    if (tip.leagueKey !== key) continue
    if (marketToTg(tip.market) !== market) continue
    addToFlatAgg(agg, tip)
  }
  finishFlatAgg(agg)
  return { settled: agg.priced, roi: agg.roi }
}

export function shouldSendTelegramForAlert(args: {
  fixtureId: string
  market: Market
  competitionId?: string | null
}): { send: boolean; key: string | null; gate: LeagueTgGate } {
  const file = loadLeagueTelegram()
  const resolved = resolveFixtureLeague(args.fixtureId)
  const key = resolved?.key ?? (args.competitionId ? `id:${args.competitionId}` : null)
  const market = marketToTg(args.market)
  const gate = key
    ? (file.leagues[key]?.[market] ?? { ...DEFAULT_LEAGUE_TG_GATE })
    : { ...DEFAULT_LEAGUE_TG_GATE }
  if (!key) return { send: gate.tg && !gate.auto, key, gate }
  const { settled, roi } = marketRoi(loadTips(), key, market)
  return {
    send: shouldSendTelegramLeague({
      gate,
      settled,
      roi,
      minTipsAuto: file.minTipsAuto,
    }),
    key,
    gate,
  }
}
