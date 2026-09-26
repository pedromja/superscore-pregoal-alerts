import { flattenFixtures } from '../src/lib/api.ts'
import type { Fixture, MomentumPayload } from '../src/lib/types.ts'
import { combinedAbortSignal } from './pollerHealth.ts'

const FETCH_TIMEOUT_MS = 8000
const JSON_RETRY_DELAY_MS = 250

export class UpstreamJsonError extends Error {
  readonly url: string
  readonly fixtureId?: string
  readonly routine: boolean

  constructor(
    message: string,
    url: string,
    fixtureId?: string,
    routine = true,
  ) {
    super(message)
    this.name = 'UpstreamJsonError'
    this.url = url
    this.fixtureId = fixtureId
    this.routine = routine
  }
}

export function isRoutineJsonError(err: unknown): boolean {
  if (err instanceof UpstreamJsonError) return err.routine
  const msg = err instanceof Error ? err.message : String(err)
  return /JSON truncado|JSON vazio|JSON inválido|Unexpected end of JSON/i.test(
    msg,
  )
}

export function parseUpstreamJson(
  text: string,
  url: string,
  fixtureId?: string,
): unknown {
  const trimmed = text.trim()
  const where = fixtureId ? `jogo ${fixtureId}` : url
  if (!trimmed) {
    throw new UpstreamJsonError(`JSON vazio (${where})`, url, fixtureId)
  }
  try {
    return JSON.parse(trimmed)
  } catch (err) {
    const raw = err instanceof Error ? err.message : 'JSON inválido'
    const truncated = /Unexpected end of JSON|end of JSON input/i.test(raw)
    const message = truncated
      ? `JSON truncado (${where})`
      : `JSON inválido: ${raw} (${where})`
    throw new UpstreamJsonError(message, url, fixtureId)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function fetchUpstreamJson(
  url: string,
  label: string,
  fixtureId?: string,
  signal?: AbortSignal,
): Promise<unknown> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error(`${label} abortado`)
    }
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: combinedAbortSignal(FETCH_TIMEOUT_MS, signal),
      })
      if (!res.ok) throw new Error(`${label} ${res.status}`)
      const text = await res.text()
      return parseUpstreamJson(text, url, fixtureId)
    } catch (err) {
      lastErr = err
      if (signal?.aborted) throw err
      if (!isRoutineJsonError(err) || attempt === 2) throw err
      console.warn(
        '[ss]',
        label,
        fixtureId ?? url,
        `tentativa ${attempt} falhou, a repetir`,
        err instanceof Error ? err.message : err,
      )
      await sleep(JSON_RETRY_DELAY_MS)
    }
  }
  throw lastErr
}

export async function fetchFixturesServer(
  date: string,
  region: string,
  signal?: AbortSignal,
): Promise<Fixture[]> {
  const params = new URLSearchParams({
    language: 'en',
    date,
    timezone_offset: '1',
  })
  const url = `https://api.content-prod.superscore.live/v2/public/stats/fixtures/by-date/${region}?${params}`
  const raw = await fetchUpstreamJson(url, 'Jogos', undefined, signal)
  if (!raw || typeof raw !== 'object') {
    throw new UpstreamJsonError(`JSON inválido (${url})`, url)
  }
  return flattenFixtures(raw as Parameters<typeof flattenFixtures>[0])
}

export async function fetchMomentumServer(
  fixtureId: string,
  signal?: AbortSignal,
): Promise<MomentumPayload> {
  const url = `https://scorealarm-stats.freetls.fastly.net/v2/soccer/fixtures/attacking-momentum/superscore/en?fixture-id=${encodeURIComponent(fixtureId)}`
  const raw = await fetchUpstreamJson(url, 'Momentum', fixtureId, signal)
  const payload = raw as MomentumPayload
  if (!payload || !Array.isArray(payload.timeline)) {
    throw new UpstreamJsonError(
      `Momentum sem timeline (jogo ${fixtureId})`,
      url,
      fixtureId,
    )
  }
  return payload
}

export function lisbonDate(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Lisbon',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}
