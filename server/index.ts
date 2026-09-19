import { existsSync } from 'node:fs'
import { join } from 'node:path'
import express from 'express'
import { alertNotificationCopy, sampleFeedAlert } from '../src/lib/tally.ts'
import type { CornerHalf, Market } from '../src/lib/types.ts'
import { parseCornerHalfOpt } from '../src/lib/windows.ts'
import { DEFINITIONS_LOCKED } from '../src/lib/lock.ts'
import {
  LEARN_AUTO_APPLY,
  LEARN_AUTO_MIN_OUTCOMES,
  ROOT,
  SERVER_PORT,
  vapid,
} from './config.ts'
import {
  applyProposal,
  computeMetrics,
  currentSettings,
  ingestFeedAlerts,
  putParams,
  recalculate,
  resetLearnStats,
  resolveMarket,
  seedDemos,
  setFeedback,
} from './learn.ts'
import { getPollerStatus, startPoller } from './poller.ts'
import { getTelegramStatus, sendTelegramAlert } from './telegram.ts'
import { scheduleTelegramOutcomeFlush } from './telegramOutcomes.ts'
import {
  addSubscription,
  publicVapidKey,
  removeSubscription,
  sendPushToAll,
} from './push.ts'
import {
  loadActiveMarket,
  loadAlerts,
  loadHistory,
  loadOddsObservations,
  loadProposal,
  loadSubscriptions,
  saveActiveMarket,
} from './store.ts'
import {
  applyTipOverlay,
  ingestRobobet,
  overlayPayload,
  proposeTipOverlay,
  tipsPayload,
} from './tips.ts'
import type { PushSub } from './types.ts'

const app = express()
app.use(express.json({ limit: '2mb' }))

function marketFromReq(req: express.Request): Market {
  const q = req.query.market
  const bodyMarket =
    req.body && typeof req.body === 'object' && 'market' in req.body
      ? (req.body as { market?: unknown }).market
      : undefined
  return resolveMarket(typeof q === 'string' ? q : bodyMarket)
}

function halfFromReq(req: express.Request): CornerHalf | undefined {
  const q = req.query.half
  const bodyHalf =
    req.body && typeof req.body === 'object' && 'half' in req.body
      ? (req.body as { half?: unknown }).half
      : undefined
  return parseCornerHalfOpt(typeof q === 'string' ? q : bodyHalf)
}

function learnPayload(market: Market, half?: CornerHalf) {
  const settings = currentSettings(market, half)
  return {
    market,
    half: settings.cornerHalf,
    summary: computeMetrics(settings),
    settings,
    proposal: loadProposal(market, half),
    history: loadHistory(market, half).slice(-12).reverse(),
    recentAlerts: loadAlerts(market, half).slice(-40).reverse(),
    autoAfter: LEARN_AUTO_MIN_OUTCOMES,
    autoApply: false,
    confirmRequired: true,
    locked: DEFINITIONS_LOCKED,
    learnAutoApplyEnv: LEARN_AUTO_APPLY,
  }
}

app.get('/api/push/vapidPublicKey', (_req, res) => {
  res.json({ publicKey: publicVapidKey() })
})

app.post('/api/push/subscribe', (req, res) => {
  const body = req.body as { endpoint?: string; keys?: { p256dh?: string; auth?: string } }
  if (!body.endpoint || !body.keys?.p256dh || !body.keys.auth) {
    res.status(400).json({ error: 'Subscription inválida' })
    return
  }
  const sub: PushSub = {
    endpoint: body.endpoint,
    keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
    createdAt: new Date().toISOString(),
  }
  addSubscription(sub)
  res.json({ ok: true, subscribers: loadSubscriptions().length })
})

app.delete('/api/push/subscribe', (req, res) => {
  const endpoint = String(
    (req.body as { endpoint?: string })?.endpoint || req.query.endpoint || '',
  )
  if (!endpoint) {
    res.status(400).json({ error: 'endpoint em falta' })
    return
  }
  removeSubscription(endpoint)
  res.json({ ok: true })
})

app.get('/api/push/status', (_req, res) => {
  res.json({
    subscribers: loadSubscriptions().length,
    hasVapid: Boolean(vapid.publicKey),
  })
})

app.post('/api/push/test', async (req, res) => {
  const market = marketFromReq(req)
  const sample = sampleFeedAlert(market, halfFromReq(req) ?? 'ht')
  const copy = alertNotificationCopy(sample)
  const result = await sendPushToAll({
    title: copy.title,
    body: copy.body,
    url: '/#/monitor?alert=demo-teste%3Aprimary-1-38-0',
    alertKey: 'demo-teste:primary-1-38-0',
    tag: market === 'goals' ? 'pregoal:test' : 'precantos:test',
  })
  res.json(result)
})

app.get('/api/poller/status', (_req, res) => {
  res.json(getPollerStatus())
})

app.get('/api/telegram/status', (_req, res) => {
  res.json(getTelegramStatus())
})

app.post('/api/telegram/test', async (req, res) => {
  const market = marketFromReq(req)
  const sample = sampleFeedAlert(market, halfFromReq(req) ?? 'ht')
  const copy = alertNotificationCopy(sample)
  const result = await sendTelegramAlert({
    title: copy.title,
    body: copy.body,
    url: '/#/monitor?alert=demo-teste%3Aprimary-1-38-0',
    alertKey: 'demo-teste:primary-1-38-0',
    ruleLabel: sample.ruleName,
  })
  res.json({ ...result, ...getTelegramStatus() })
})

app.post('/api/robobet/ingest', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const text = body.texto_alerta ?? body.text
  const hasParsed =
    body.odd !== undefined ||
    body.jogo !== undefined ||
    body.mercado !== undefined ||
    body.liga !== undefined
  if (typeof text !== 'string' && !hasParsed) {
    res.status(400).json({ error: 'texto_alerta ou text em falta' })
    return
  }
  const quote = ingestRobobet(body)
  res.json({
    ok: true,
    quote,
    usable: Boolean(quote.odd && quote.odd > 1),
  })
})

app.get('/api/tips', (_req, res) => {
  res.json(tipsPayload())
})

app.get('/api/tips/observations', (_req, res) => {
  res.json({ items: loadOddsObservations().slice(-200).reverse() })
})

app.get('/api/tips/overlay', (_req, res) => {
  res.json(overlayPayload())
})

app.put('/api/tips/overlay', (req, res) => {
  const body = (req.body ?? {}) as { overlay?: unknown; confirm?: unknown }
  const overlay = body.overlay ?? ('requireOdd' in (body as object) ? req.body : undefined)
  try {
    if (body.confirm === true) {
      res.json(applyTipOverlay({ confirm: true, overlay, reason: 'manual' }))
      return
    }
    if (overlay === undefined) {
      res.status(400).json({ error: 'overlay em falta' })
      return
    }
    res.json(proposeTipOverlay(overlay, 'manual'))
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'erro' })
  }
})

app.post('/api/tips/overlay/apply', (req, res) => {
  const body = (req.body ?? {}) as {
    confirm?: unknown
    confirmed?: unknown
    overlay?: unknown
    id?: string
  }
  const confirm = body.confirm === true || body.confirmed === true
  try {
    res.json(
      applyTipOverlay({
        confirm,
        overlay: body.overlay,
        id: body.id,
        reason: 'manual',
      }),
    )
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'erro' })
  }
})

app.get('/api/learn/market', (_req, res) => {
  const market = loadActiveMarket()
  res.json({
    market,
    settings: currentSettings(market),
    locked: DEFINITIONS_LOCKED,
    halves: {
      ht: currentSettings(market, 'ht'),
      ft: currentSettings(market, 'ft'),
    },
    corners: market === 'corners'
      ? {
          ht: currentSettings('corners', 'ht'),
          ft: currentSettings('corners', 'ft'),
        }
      : undefined,
  })
})

app.put('/api/learn/market', (req, res) => {
  const market = resolveMarket(
    (req.body as { market?: unknown } | undefined)?.market,
  )
  saveActiveMarket(market)
  res.json({ market, settings: currentSettings(market) })
})

app.post('/api/learn/market', (req, res) => {
  const market = resolveMarket(
    (req.body as { market?: unknown } | undefined)?.market,
  )
  saveActiveMarket(market)
  res.json({ market, settings: currentSettings(market) })
})

app.get('/api/learn/summary', (req, res) => {
  const market = marketFromReq(req)
  const half = halfFromReq(req)
  if (!half) {
    res.json({
      market,
      ht: learnPayload(market, 'ht'),
      ft: learnPayload(market, 'ft'),
    })
    return
  }
  res.json(learnPayload(market, half))
})

app.post('/api/learn/alerts', (req, res) => {
  const market = marketFromReq(req)
  const half = halfFromReq(req)
  const alerts = Array.isArray(req.body) ? req.body : req.body?.alerts
  if (!Array.isArray(alerts)) {
    res.status(400).json({ error: 'alerts[] em falta' })
    return
  }
  const stored = ingestFeedAlerts(
    alerts,
    currentSettings(market, half),
    false,
    market,
    half,
  )
  scheduleTelegramOutcomeFlush()
  res.json({ ok: true, n: stored.length, market, half })
})

app.post('/api/learn/feedback', (req, res) => {
  try {
    const market = marketFromReq(req)
    const half = halfFromReq(req)
    const { id, feedback } = req.body as {
      id?: string
      feedback?: 'up' | 'down' | null
    }
    if (!id) {
      res.status(400).json({ error: 'id em falta' })
      return
    }
    res.json(setFeedback(id, feedback ?? null, market, half))
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : 'erro' })
  }
})

app.post('/api/learn/recalculate', (req, res) => {
  const market = marketFromReq(req)
  const half = halfFromReq(req)
  const reason = String((req.body as { reason?: string })?.reason || 'manual')
  try {
    res.json(recalculate(reason, market, half))
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'erro' })
  }
})

app.post('/api/learn/apply', (req, res) => {
  try {
    const market = marketFromReq(req)
    const half = halfFromReq(req)
    const body = (req.body ?? {}) as {
      id?: string
      confirm?: unknown
      confirmed?: unknown
    }
    const id = String(body.id || 'latest')
    const confirm = body.confirm === true || body.confirmed === true
    const unlock = (body as { unlock?: unknown }).unlock === true
    res.json(applyProposal(id, 'manual', market, half, { confirm, unlock }))
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'erro' })
  }
})

app.post('/api/learn/seed-demos', (req, res) => {
  const market = marketFromReq(req)
  const half = halfFromReq(req)
  const seeded = seedDemos(market, half)
  const proposals = !half
    ? {
        ht: recalculate('seed-demos', market, 'ht'),
        ft: recalculate('seed-demos', market, 'ft'),
      }
    : { latest: recalculate('seed-demos', market, half) }
  res.json({
    ...seeded,
    market,
    half,
    proposals,
    summary: !half
      ? {
          ht: computeMetrics(currentSettings(market, 'ht')),
          ft: computeMetrics(currentSettings(market, 'ft')),
        }
      : computeMetrics(currentSettings(market, half)),
  })
})

app.post('/api/learn/reset', (req, res) => {
  const body = (req.body ?? {}) as { confirm?: unknown; market?: unknown }
  try {
    const result = resetLearnStats({
      confirm: body.confirm,
      market: body.market,
    })
    res.json({
      ok: true,
      ...result,
      note:
        'Limpou alertas, outcomes e propostas. params, sent-keys, VAPID/subs e tip overlay ficaram. sent.json mantém-se para não reenviar push dos mesmos ids.',
    })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'erro' })
  }
})

app.get('/api/learn/params', (req, res) => {
  const market = marketFromReq(req)
  const half = halfFromReq(req)
  if (!half) {
    res.json({
      locked: DEFINITIONS_LOCKED,
      ht: currentSettings(market, 'ht'),
      ft: currentSettings(market, 'ft'),
    })
    return
  }
  res.json({
    locked: DEFINITIONS_LOCKED,
    settings: currentSettings(market, half),
  })
})

app.put('/api/learn/params', (req, res) => {
  try {
    const market = marketFromReq(req)
    const half = halfFromReq(req)
    const body = (req.body ?? {}) as {
      confirm?: unknown
      confirmed?: unknown
      unlock?: unknown
      settings?: Partial<import('../src/lib/types.ts').AlertSettings>
    }
    const confirm = body.confirm === true || body.confirmed === true
    const unlock = body.unlock === true
    const incoming = body.settings ?? (req.body as Record<string, unknown>)
    res.json(
      putParams(
        {
          ...currentSettings(market, half),
          ...(incoming as object),
          market,
          cornerHalf: half ?? currentSettings(market, half).cornerHalf,
        },
        { confirm, unlock },
      ),
    )
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'erro' })
  }
})

app.use('/api/ss-fixtures', async (req, res) => {
  try {
    const url = `https://api.content-prod.superscore.live/v2/public/stats/fixtures${req.url}`
    const upstream = await fetch(url)
    res.status(upstream.status)
    res.setHeader(
      'content-type',
      upstream.headers.get('content-type') || 'application/json',
    )
    res.send(Buffer.from(await upstream.arrayBuffer()))
  } catch {
    res.status(502).json({ error: 'fixtures upstream' })
  }
})

app.use('/api/ss-momentum', async (req, res) => {
  try {
    const url = `https://scorealarm-stats.freetls.fastly.net/v2/soccer/fixtures/attacking-momentum/superscore/en${req.url}`
    const upstream = await fetch(url)
    res.status(upstream.status)
    res.setHeader(
      'content-type',
      upstream.headers.get('content-type') || 'application/json',
    )
    res.send(Buffer.from(await upstream.arrayBuffer()))
  } catch {
    res.status(502).json({ error: 'momentum upstream' })
  }
})

const dist = join(ROOT, 'dist')
if (existsSync(dist)) {
  app.use(express.static(dist))
  app.get(/.*/, (req, res, next) => {
    if (req.path.startsWith('/api')) {
      next()
      return
    }
    res.sendFile(join(dist, 'index.html'))
  })
}

app.listen(SERVER_PORT, '0.0.0.0', () => {
  console.log(`SuperScore API em 0.0.0.0:${SERVER_PORT}`)
  startPoller()
})
