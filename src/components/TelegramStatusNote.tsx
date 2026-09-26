import { useEffect, useState } from 'react'
import { fetchTelegramStatus, type TelegramStatus } from '../lib/learnApi'

export function TelegramStatusNote() {
  const [status, setStatus] = useState<TelegramStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    void fetchTelegramStatus().then((next) => {
      if (!cancelled) setStatus(next)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const configured = status?.configured === true
  const enabled = status?.enabled === true
  const last = status?.lastSendAt
    ? new Date(status.lastSendAt).toLocaleString('pt-PT')
    : null

  return (
    <section className="rounded-2xl border border-line bg-panel p-4">
      <p className="text-xs tracking-wider text-lime uppercase">Avisos</p>
      <h2 className="text-lg font-semibold">Telegram</h2>
      <p className="mt-1 text-sm text-emerald-100/70">
        Avisos via Telegram (bot). Web Push desligado.
      </p>
      <p className="mt-2 text-xs text-emerald-100/55">
        {status == null
          ? 'A ler estado do servidor…'
          : enabled
            ? 'Bot configurado no servidor. Os alertas Golo/Canto saem para o chat definido nas variáveis Railway.'
            : configured
              ? 'Bot definido mas TELEGRAM_ENABLED=0 — avisos desligados.'
              : 'Bot ainda sem TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID no servidor.'}
      </p>
      {last ? (
        <p className="mt-1 text-xs text-emerald-100/45">Último envio: {last}</p>
      ) : null}
      {status?.lastError ? (
        <p className="mt-1 text-xs text-rose-200/80">
          Último erro: {status.lastError}
        </p>
      ) : null}
    </section>
  )
}
