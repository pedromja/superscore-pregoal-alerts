import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'
import webpush from 'web-push'
import { defaultsFor } from '../src/lib/market.ts'
import type { AlertSettings } from '../src/lib/types.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
loadEnv({ path: join(root, '.env') })

export const ROOT = root
export const DATA_DIR = process.env.DATA_DIR
  ? join(root, process.env.DATA_DIR)
  : join(root, 'data')
export const MATCHES_DIR = join(DATA_DIR, 'matches')
export const SERVER_PORT = Number(process.env.PORT || 43174)
export const POLLER_REGION =
  process.env.POLLER_REGION || process.env.POLL_REGION || 'ro'
export const POLLER_INTERVAL_MS = Number(process.env.POLLER_INTERVAL_MS || 45000)
export const POLLER_ENABLED = process.env.POLLER_ENABLED !== '0'
/** Live fixtures processed per tick (priority windows first, then a rotating fill). */
export const POLLER_LIVE_LIMIT = Number(process.env.POLLER_LIVE_LIMIT || 24)
export const POLLER_FINISHED_LIMIT = Number(process.env.POLLER_FINISHED_LIMIT || 6)
/** Parallel fixture processors. Store writes still serialize. */
export const POLLER_CONCURRENCY = Number(process.env.POLLER_CONCURRENCY || 5)
/** One hung momentum fetch cannot freeze the rest of the tick. */
export const POLLER_FIXTURE_TIMEOUT_MS = Number(
  process.env.POLLER_FIXTURE_TIMEOUT_MS || 12_000,
)
/** If a tick never returns, clear inFlight so the next interval can run. */
export const POLLER_TICK_WATCHDOG_MS = Number(
  process.env.POLLER_TICK_WATCHDOG_MS || 80_000,
)
export const POLLER_JSON_BACKOFF_MAX_MS = Number(
  process.env.POLLER_JSON_BACKOFF_MAX_MS || 10 * 60 * 1000,
)
/** Public SokkerPro O/U odds. Default ON; set `SOKKERPRO_ODDS=0` to disable. Soft-fail. */
export const SOKKERPRO_ODDS = process.env.SOKKERPRO_ODDS !== '0'
export const LEARN_WINDOW = Number(process.env.LEARN_WINDOW || 5)
export const LEARN_AUTO_MIN_OUTCOMES = Number(
  process.env.LEARN_AUTO_MIN_OUTCOMES || 50,
)
/** Silent auto-apply is off. Only POST /api/learn/apply with confirm:true writes params. */
export const LEARN_AUTO_APPLY = process.env.LEARN_AUTO_APPLY === '1'
export const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:dev@localhost'

/** Bot API token. Empty = Telegram channel off. Never log this value. */
export function telegramBotToken(): string {
  return (process.env.TELEGRAM_BOT_TOKEN || '').trim()
}

/** Destination chat / group / channel id (may be negative). */
export function telegramChatId(): string {
  return (process.env.TELEGRAM_CHAT_ID || '').trim()
}

export function telegramConfigured(): boolean {
  return Boolean(telegramBotToken() && telegramChatId())
}

/** Default on when token + chat are set. `TELEGRAM_ENABLED=0` forces off. */
export function telegramEnabled(): boolean {
  return telegramConfigured() && process.env.TELEGRAM_ENABLED !== '0'
}

/** Dormant by default. `WEB_PUSH_ENABLED=1` re-enables the old channel. */
export function webPushEnabled(): boolean {
  return process.env.WEB_PUSH_ENABLED === '1'
}

export const TELEGRAM_TIMEOUT_MS = Number(process.env.TELEGRAM_TIMEOUT_MS || 9000)

/** `webhook` (default) or `poll`. `off` skips inbound callback handling. */
export function telegramUpdatesMode(): 'webhook' | 'poll' | 'off' {
  const raw = (process.env.TELEGRAM_UPDATES || 'webhook').trim().toLowerCase()
  if (raw === 'poll' || raw === 'longpoll') return 'poll'
  if (raw === '0' || raw === 'off' || raw === 'none') return 'off'
  return 'webhook'
}

export function telegramWebhookSecret(): string {
  const explicit = (process.env.TELEGRAM_WEBHOOK_SECRET || '').trim()
  if (explicit) return explicit
  const token = telegramBotToken()
  if (!token) return ''
  return `ss${token.replace(/[^A-Za-z0-9_-]/g, '').slice(-24)}wh`
}

function resolvePublicAppUrl(): string {
  const raw = (
    process.env.PUBLIC_URL ||
    process.env.APP_URL ||
    process.env.RAILWAY_PUBLIC_DOMAIN ||
    ''
  ).trim()
  const fallback = 'https://web-production-837b3.up.railway.app'
  const value = raw || fallback
  const withProto = /^https?:\/\//i.test(value) ? value : `https://${value}`
  return withProto.replace(/\/$/, '')
}

/** Public origin for monitor deep-links in Telegram (no trailing slash). */
export function publicAppUrl(): string {
  return resolvePublicAppUrl()
}

mkdirSync(MATCHES_DIR, { recursive: true })

type VapidFile = { publicKey: string; privateKey: string; subject: string }

function readVapidFile(): VapidFile | null {
  const path = join(DATA_DIR, 'vapid.json')
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as VapidFile
  } catch {
    return null
  }
}

function ensureVapid(): VapidFile {
  const fromEnv =
    process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
      ? {
          publicKey: process.env.VAPID_PUBLIC_KEY,
          privateKey: process.env.VAPID_PRIVATE_KEY,
          subject: VAPID_SUBJECT,
        }
      : null
  if (fromEnv) return fromEnv
  const existing = readVapidFile()
  if (existing?.publicKey && existing.privateKey) {
    return { ...existing, subject: existing.subject || VAPID_SUBJECT }
  }
  const generated = webpush.generateVAPIDKeys()
  const stored: VapidFile = {
    publicKey: generated.publicKey,
    privateKey: generated.privateKey,
    subject: VAPID_SUBJECT,
  }
  writeFileSync(join(DATA_DIR, 'vapid.json'), JSON.stringify(stored, null, 2))
  return stored
}

export const vapid = ensureVapid()

export function pollerSettings(overrides?: Partial<AlertSettings>): AlertSettings {
  const market = overrides?.market ?? 'goals'
  const defaults = defaultsFor(market, overrides?.cornerHalf)
  return {
    ...defaults,
    ...overrides,
    evaluationWindow:
      market === 'corners' ? defaults.evaluationWindow : LEARN_WINDOW,
  }
}
