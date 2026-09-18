import { Activity, Settings2, TimerReset } from 'lucide-react'
import { useEffect, useState } from 'react'
import { lisbonToday } from './lib/format'
import { loadSettings, saveSettings } from './lib/settings'
import { MonitorPage } from './pages/MonitorPage'
import { ReplayPage } from './pages/ReplayPage'
import { SettingsPage } from './pages/SettingsPage'
import type { AlertSettings, TabId } from './lib/types'

const TABS: { id: TabId; label: string; icon: typeof Activity }[] = [
  { id: 'monitor', label: 'Alertas ao vivo', icon: Activity },
  { id: 'replay', label: 'Replay / treino', icon: TimerReset },
  { id: 'definicoes', label: 'Definições', icon: Settings2 },
]

function tabFromHash(): TabId {
  const hash = window.location.hash.replace('#/', '')
  if (hash === 'replay' || hash === 'definicoes' || hash === 'monitor') return hash
  return 'monitor'
}

export default function App() {
  const [tab, setTab] = useState<TabId>(tabFromHash)
  const [settings, setSettings] = useState<AlertSettings>(() => loadSettings())
  const [date, setDate] = useState(lisbonToday)

  useEffect(() => {
    const onHash = () => setTab(tabFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    saveSettings(settings)
  }, [settings])

  function go(next: TabId) {
    setTab(next)
    const url = new URL(window.location.href)
    url.hash = `/${next}`
    window.history.replaceState(null, '', url)
  }

  return (
    <div className="mx-auto min-h-svh max-w-7xl px-4 py-5 md:px-6">
      <header className="mb-6 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-xs font-semibold tracking-[0.22em] text-lime uppercase">
            SuperScore
          </p>
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
            Alertas pré-golo
          </h1>
          <p className="mt-1 max-w-xl text-sm text-emerald-100/60">
            Momentum de ataque assinado (−100 fora / +100 casa). As regras
            disparam <em>antes</em> do golo — um spike no minuto do golo é
            coincidente, não um acerto.
          </p>
        </div>
        <nav className="flex flex-wrap gap-2">
          {TABS.map((item) => {
            const Icon = item.icon
            const active = tab === item.id
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => go(item.id)}
                className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm ${
                  active
                    ? 'bg-lime text-pitch'
                    : 'border border-line text-emerald-100/75 hover:border-lime/40'
                }`}
              >
                <Icon size={14} />
                {item.label}
              </button>
            )
          })}
        </nav>
      </header>

      {tab === 'monitor' ? (
        <MonitorPage settings={settings} date={date} onDate={setDate} />
      ) : null}
      {tab === 'replay' ? (
        <ReplayPage settings={settings} date={date} onDate={setDate} />
      ) : null}
      {tab === 'definicoes' ? (
        <SettingsPage settings={settings} onChange={setSettings} />
      ) : null}
    </div>
  )
}
