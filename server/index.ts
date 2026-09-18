import express from 'express'
import {
  LEARN_AUTO_MIN_OUTCOMES,
  SERVER_PORT,
  vapid,
} from './config.ts'
import {
  applyProposal,
  computeMetrics,
  currentSettings,
  ingestFeedAlerts,
  recalculate,
  seedDemos,
  setFeedback,
} from './learn.ts'
import { getPollerStatus, startPoller } from './poller.ts'
import {
  addSubscription,
  publicVapidKey,
  removeSubscription,
  sendPushToAll,
} from './push.ts'
import { loadAlerts, loadHistory, loadProposal, loadSubscriptions } from './store.ts'
import type { PushSub } from './types.ts'

const app = express()
app.use(express.json({ limit: '2mb' }))

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

app.post('/api/push/test', async (_req, res) => {
  const result = await sendPushToAll({
    title: 'Primária · Celtic vs Ferencváros',
    body: "38' · Fora · v −61",
    url: '/#/monitor?alert=demo-teste%3Aprimary-1-38-0',
    alertKey: 'demo-teste:primary-1-38-0',
    tag: 'pregoal:test',
  })
  res.json(result)
})

app.get('/api/poller/status', (_req, res) => {
  res.json(getPollerStatus())
})

app.get('/api/learn/summary', (_req, res) => {
  res.json({
    summary: computeMetrics(),
    settings: currentSettings(),
    proposal: loadProposal(),
    history: loadHistory().slice(-12).reverse(),
    recentAlerts: loadAlerts().slice(-40).reverse(),
    autoAfter: LEARN_AUTO_MIN_OUTCOMES,
  })
})

app.post('/api/learn/alerts', (req, res) => {
  const alerts = Array.isArray(req.body) ? req.body : req.body?.alerts
  if (!Array.isArray(alerts)) {
    res.status(400).json({ error: 'alerts[] em falta' })
    return
  }
  const stored = ingestFeedAlerts(alerts, currentSettings(), false)
  res.json({ ok: true, n: stored.length })
})

app.post('/api/learn/feedback', (req, res) => {
  try {
    const { id, feedback } = req.body as {
      id?: string
      feedback?: 'up' | 'down' | null
    }
    if (!id) {
      res.status(400).json({ error: 'id em falta' })
      return
    }
    res.json(setFeedback(id, feedback ?? null))
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : 'erro' })
  }
})

app.post('/api/learn/recalculate', (req, res) => {
  const reason = String((req.body as { reason?: string })?.reason || 'manual')
  res.json(recalculate(reason))
})

app.post('/api/learn/apply', (req, res) => {
  try {
    const id = String((req.body as { id?: string })?.id || 'latest')
    res.json(applyProposal(id, 'manual'))
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'erro' })
  }
})

app.post('/api/learn/seed-demos', (_req, res) => {
  const seeded = seedDemos()
  const proposal = recalculate('seed-demos')
  res.json({ ...seeded, proposal, summary: computeMetrics() })
})

app.get('/api/learn/params', (_req, res) => {
  res.json(currentSettings())
})

app.listen(SERVER_PORT, '0.0.0.0', () => {
  console.log(`SuperScore API em http://127.0.0.1:${SERVER_PORT}`)
  startPoller()
})
