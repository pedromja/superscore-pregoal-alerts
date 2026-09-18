import { Bell, BellOff, BellRing } from 'lucide-react'
import { useEffect, useState } from 'react'
import { loadFeed, saveFeed } from '../lib/monitorStore'
import {
  buildTestAlert,
  currentPermission,
  feedAlertKey,
  notificationsSupported,
  registerServiceWorker,
  requestNotificationPermission,
  showAlertNotification,
  type NotifyPermission,
} from '../lib/notifications'
import {
  currentPushSubscription,
  sendRemoteTest,
  subscribeRemotePush,
  unsubscribeRemotePush,
} from '../lib/pushRemote'
import type { AlertSettings } from '../lib/types'

type Props = {
  settings: AlertSettings
  onChange: (next: AlertSettings) => void
  compact?: boolean
}

export function useNotifyPermission(): {
  permission: NotifyPermission
  activate: () => Promise<NotifyPermission>
} {
  const [permission, setPermission] = useState<NotifyPermission>(() =>
    notificationsSupported() ? currentPermission() : 'unsupported',
  )

  useEffect(() => {
    void registerServiceWorker()
    setPermission(notificationsSupported() ? currentPermission() : 'unsupported')
    if (!navigator.permissions?.query) return
    let permissionStatus: PermissionStatus | null = null
    const sync = () => setPermission(currentPermission())
    void navigator.permissions
      .query({ name: 'notifications' })
      .then((result) => {
        permissionStatus = result
        result.addEventListener('change', sync)
      })
      .catch(() => undefined)
    return () => {
      permissionStatus?.removeEventListener('change', sync)
    }
  }, [])

  async function activate(): Promise<NotifyPermission> {
    const next = await requestNotificationPermission()
    setPermission(next)
    return next
  }

  return { permission, activate }
}

export function NotificationBar({ settings, onChange, compact = false }: Props) {
  const { permission, activate } = useNotifyPermission()
  const [testNote, setTestNote] = useState<string | null>(null)
  const [remote, setRemote] = useState(false)
  const [remoteNote, setRemoteNote] = useState<string | null>(null)

  useEffect(() => {
    void currentPushSubscription().then((sub) => setRemote(Boolean(sub)))
  }, [])

  if (permission === 'unsupported') {
    return (
      <div className="rounded-2xl border border-line bg-panel px-3 py-3 text-sm text-emerald-100/65">
        Este browser não suporta notificações web. No iPhone use Safari e
        «Adicionar ao ecrã inicial».
      </div>
    )
  }

  async function handleActivate() {
    const next = await activate()
    if (next === 'granted') {
      onChange({ ...settings, notificationsEnabled: true, notifyPrimary: true })
    }
  }

  async function handleTest() {
    if (permission !== 'granted') {
      const next = await activate()
      if (next !== 'granted') {
        setTestNote('Permissão recusada. Ative nas definições do browser.')
        return
      }
    }
    const sample = buildTestAlert()
    const feed = loadFeed()
    const key = feedAlertKey(sample)
    if (!feed.some((item) => feedAlertKey(item) === key)) {
      saveFeed([sample, ...feed])
    }
    await showAlertNotification(sample)
    setTestNote('Notificação de teste enviada. Clique nela para abrir o alerta.')
  }

  if (compact) {
    if (permission === 'granted' && settings.notificationsEnabled) {
      return (
        <p className="inline-flex items-center gap-1 text-xs text-lime">
          <BellRing size={12} />
          {remote ? 'Push remoto ativo' : 'Notificações ativas'}
        </p>
      )
    }
    if (permission === 'denied') {
      return (
        <p className="inline-flex items-center gap-1 text-xs text-rose-300/80">
          <BellOff size={12} />
          Notificações bloqueadas
        </p>
      )
    }
    return (
      <button
        type="button"
        onClick={() => void handleActivate()}
        className="inline-flex items-center gap-2 rounded-full bg-lime px-3 py-1.5 text-sm font-semibold text-pitch"
      >
        <Bell size={14} />
        Ativar notificações
      </button>
    )
  }

  return (
    <section className="space-y-3 rounded-2xl border border-line bg-panel p-4">
      <div>
        <p className="text-xs tracking-wider text-lime uppercase">
          Notificações
        </p>
        <h2 className="text-lg font-semibold">Telemóvel e PC</h2>
        <p className="mt-1 text-sm text-emerald-100/60">
          Locais: o separador/PWA tem de estar aberto. Remotas: o poller do
          servidor envia Web Push mesmo com a app fechada (VAPID).
        </p>
      </div>

      {permission !== 'granted' ? (
        <button
          type="button"
          onClick={() => void handleActivate()}
          className="inline-flex items-center gap-2 rounded-xl bg-lime px-4 py-2.5 text-sm font-semibold text-pitch"
        >
          <Bell size={16} />
          Ativar notificações
        </button>
      ) : (
        <p className="inline-flex items-center gap-2 text-sm text-lime">
          <BellRing size={16} />
          Permissão concedida neste dispositivo
        </p>
      )}

      {permission === 'denied' ? (
        <p className="text-sm text-rose-200">
          O browser bloqueou as notificações. No PC: ícone à esquerda da
          barra de endereço → Permitir. No Android: Definições do site. No
          iPhone só funciona depois de «Adicionar ao ecrã inicial».
        </p>
      ) : null}

      <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-pitch px-3 py-3">
        <input
          type="checkbox"
          checked={settings.notificationsEnabled}
          onChange={(e) =>
            onChange({ ...settings, notificationsEnabled: e.target.checked })
          }
          className="mt-1 accent-lime"
        />
        <span>
          <span className="block text-sm font-semibold">Enviar notificações</span>
          <span className="block text-xs text-emerald-100/55">
            Liga/desliga os avisos sem alterar a permissão do browser
          </span>
        </span>
      </label>

      <div className="space-y-2">
        <p className="text-[11px] tracking-wider text-emerald-100/45 uppercase">
          Quais regras avisam
        </p>
        <RuleNotifyToggle
          checked={settings.notifyPrimary}
          title="Primária"
          detail="Ligado por defeito — regra recomendada do treino"
          onChange={(v) => onChange({ ...settings, notifyPrimary: v })}
        />
        <RuleNotifyToggle
          checked={settings.notifySecondary}
          title="Secundária"
          detail="Swing |Δ1| ≥ 60"
          onChange={(v) => onChange({ ...settings, notifySecondary: v })}
        />
        <RuleNotifyToggle
          checked={settings.notifyFallback}
          title="Reserva"
          detail="Sustained ×4 — mais ruidosa"
          onChange={(v) => onChange({ ...settings, notifyFallback: v })}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void handleTest()}
          className="rounded-xl border border-line px-3 py-2 text-sm hover:border-lime/50"
        >
          Teste local
        </button>
        {testNote ? (
          <span className="text-xs text-emerald-100/60">{testNote}</span>
        ) : null}
      </div>

      <div className="rounded-xl border border-line bg-pitch px-3 py-3">
        <p className="text-sm font-semibold">Push remoto (app fechada)</p>
        <p className="mt-1 text-xs text-emerald-100/55">
          {remote
            ? 'Este dispositivo está subscrito. O poller avisa os telemóveis e PCs registados.'
            : 'Subscreva para receber alertas com a PWA fechada.'}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {remote ? (
            <button
              type="button"
              onClick={() =>
                void unsubscribeRemotePush()
                  .then(() => {
                    setRemote(false)
                    setRemoteNote('Subscription removida.')
                  })
                  .catch((err: unknown) =>
                    setRemoteNote(err instanceof Error ? err.message : 'Falha'),
                  )
              }
              className="rounded-xl border border-line px-3 py-2 text-sm"
            >
              Cancelar Push remoto
            </button>
          ) : (
            <button
              type="button"
              onClick={() =>
                void subscribeRemotePush()
                  .then(() => {
                    setRemote(true)
                    onChange({
                      ...settings,
                      notificationsEnabled: true,
                      notifyPrimary: true,
                    })
                    setRemoteNote('Subscrito. Pode fechar a app.')
                  })
                  .catch((err: unknown) =>
                    setRemoteNote(err instanceof Error ? err.message : 'Falha'),
                  )
              }
              className="rounded-xl bg-lime px-3 py-2 text-sm font-semibold text-pitch"
            >
              Ativar notificações remotas
            </button>
          )}
          <button
            type="button"
            onClick={() =>
              void sendRemoteTest()
                .then((r) =>
                  setRemoteNote(`Push de teste enviado a ${r.sent} dispositivo(s).`),
                )
                .catch((err: unknown) =>
                  setRemoteNote(err instanceof Error ? err.message : 'Servidor offline'),
                )
            }
            className="rounded-xl border border-line px-3 py-2 text-sm"
          >
            Teste remoto
          </button>
        </div>
        {remoteNote ? (
          <p className="mt-2 text-xs text-emerald-100/60">{remoteNote}</p>
        ) : null}
      </div>
    </section>
  )
}

function RuleNotifyToggle({
  checked,
  title,
  detail,
  onChange,
}: {
  checked: boolean
  title: string
  detail: string
  onChange: (value: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-pitch px-3 py-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 accent-lime"
      />
      <span>
        <span className="block text-sm font-semibold">{title}</span>
        <span className="block text-xs text-emerald-100/55">{detail}</span>
      </span>
    </label>
  )
}
