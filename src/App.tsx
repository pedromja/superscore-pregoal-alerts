import { Activity, Brain, Coins, Settings2, TimerReset } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { MarketToggle } from './components/MarketToggle'
import { NotificationBar } from './components/NotificationBar'
import { putActiveMarket } from './lib/learnApi'
import { lisbonToday } from './lib/format'
import { marketCopy, parseMarket, syncNotifyFlags } from './lib/market'
import { parseAppHash, registerServiceWorker } from './lib/notifications'
import {
  loadCornersByHalf,
  loadGoalsByHalf,
  loadMarket,
  saveCornersByHalf,
  saveGoalsByHalf,
  saveMarket,
} from './lib/settings'
import { LearningPage } from './pages/LearningPage'
import { MonitorPage } from './pages/MonitorPage'
import { ReplayPage } from './pages/ReplayPage'
import { SettingsPage } from './pages/SettingsPage'
import { TipsPage } from './pages/TipsPage'
import type { AlertSettings, CornersByHalf, Market, TabId } from './lib/types'

const TABS: { id: TabId; label: string; icon: typeof Activity }[] = [
  { id: 'monitor', label: 'Alertas ao vivo', icon: Activity },
  { id: 'tips', label: 'Tips / ROI', icon: Coins },
  { id: 'replay', label: 'Replay / treino', icon: TimerReset },
  { id: 'aprendizagem', label: 'Aprendizagem', icon: Brain },
  { id: 'definicoes', label: 'Definições', icon: Settings2 },
]

export default function App() {
  const initial = parseAppHash()
  const [tab, setTab] = useState<TabId>(initial.tab)
  const [focusAlertKey, setFocusAlertKey] = useState<string | null>(initial.alertKey)
  const [market, setMarket] = useState<Market>(() => loadMarket())
  const [goalsByHalf, setGoalsByHalf] = useState<CornersByHalf>(() =>
    loadGoalsByHalf(),
  )
  const [cornersByHalf, setCornersByHalf] = useState<CornersByHalf>(() =>
    loadCornersByHalf(),
  )
  const [date, setDate] = useState(lisbonToday)
  const halves = market === 'corners' ? cornersByHalf : goalsByHalf
  const settings = halves.ht
  const copy = marketCopy(market)

  useEffect(() => {
    void registerServiceWorker()
    void putActiveMarket(parseMarket(market))
  }, [])

  useEffect(() => {
    const applyHash = () => {
      const parsed = parseAppHash()
      setTab(parsed.tab)
      if (parsed.alertKey) setFocusAlertKey(parsed.alertKey)
    }
    const onSwMessage = (event: MessageEvent) => {
      if (event.data?.type !== 'OPEN_ALERT' || typeof event.data.url !== 'string') return
      const url = new URL(event.data.url, window.location.origin)
      if (url.hash) {
        window.history.replaceState(null, '', url.hash)
      }
      applyHash()
    }
    window.addEventListener('hashchange', applyHash)
    navigator.serviceWorker?.addEventListener('message', onSwMessage)
    return () => {
      window.removeEventListener('hashchange', applyHash)
      navigator.serviceWorker?.removeEventListener('message', onSwMessage)
    }
  }, [])

  useEffect(() => {
    saveMarket(market)
  }, [market])

  useEffect(() => {
    saveGoalsByHalf(goalsByHalf)
  }, [goalsByHalf])

  useEffect(() => {
    saveCornersByHalf(cornersByHalf)
  }, [cornersByHalf])

  const onFocusConsumed = useCallback(() => setFocusAlertKey(null), [])

  function go(next: TabId) {
    setTab(next)
    const url = new URL(window.location.href)
    url.hash = `/${next}`
    window.history.replaceState(null, '', url)
  }

  function switchMarket(next: Market) {
    if (next === market) return
    setMarket(next)
    void putActiveMarket(next)
  }

  function onChangeSettings(next: AlertSettings) {
    const m = parseMarket(next.market)
    const half = next.cornerHalf === 'ft' ? 'ft' : 'ht'
    if (m === 'corners') {
      setCornersByHalf((prev) => ({ ...prev, [half]: { ...next, cornerHalf: half } }))
      return
    }
    setGoalsByHalf((prev) => ({
      ...prev,
      [half]: { ...next, market: 'goals', cornerHalf: half },
    }))
  }

  function onChangeNotify(next: AlertSettings) {
    if (market === 'corners') {
      setCornersByHalf((prev) => ({
        ht: syncNotifyFlags(next, { ...prev.ht, cornerHalf: 'ht' }),
        ft: syncNotifyFlags(next, { ...prev.ft, cornerHalf: 'ft' }),
      }))
      return
    }
    setGoalsByHalf((prev) => ({
      ht: syncNotifyFlags(next, { ...prev.ht, cornerHalf: 'ht', market: 'goals' }),
      ft: syncNotifyFlags(next, { ...prev.ft, cornerHalf: 'ft', market: 'goals' }),
    }))
  }

  function onChangeCorners(next: CornersByHalf) {
    setCornersByHalf({
      ht: { ...next.ht, market: 'corners', cornerHalf: 'ht' },
      ft: { ...next.ft, market: 'corners', cornerHalf: 'ft' },
    })
  }

  function onChangeHalves(next: CornersByHalf) {
    if (market === 'corners') {
      onChangeCorners(next)
      return
    }
    setGoalsByHalf({
      ht: { ...next.ht, market: 'goals', cornerHalf: 'ht' },
      ft: { ...next.ft, market: 'goals', cornerHalf: 'ft' },
    })
  }

  return (
    <div className="mx-auto min-h-svh max-w-7xl px-4 py-5 md:px-6">
      <header className="mb-6 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-xs font-semibold tracking-[0.22em] text-lime uppercase">
            SuperScore
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
              {copy.title}
            </h1>
            <MarketToggle market={market} onChange={switchMarket} />
          </div>
          <p className="mt-1 max-w-xl text-sm text-emerald-100/60">
            {copy.blurb}
          </p>
        </div>
        <div className="flex flex-col items-start gap-3 md:items-end">
          <NotificationBar settings={settings} onChange={onChangeNotify} compact />
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
        </div>
      </header>

      {tab === 'monitor' ? (
        <MonitorPage
          settings={settings}
          cornersByHalf={halves}
          date={date}
          onDate={setDate}
          focusAlertKey={focusAlertKey}
          onFocusConsumed={onFocusConsumed}
        />
      ) : null}
      {tab === 'tips' ? <TipsPage /> : null}
      {tab === 'replay' ? (
        <ReplayPage
          settings={settings}
          cornersByHalf={halves}
          date={date}
          onDate={setDate}
        />
      ) : null}
      {tab === 'aprendizagem' ? (
        <LearningPage
          settings={settings}
          cornersByHalf={halves}
          onChange={onChangeSettings}
          onChangeCorners={onChangeHalves}
        />
      ) : null}
      {tab === 'definicoes' ? (
        <SettingsPage
          settings={settings}
          cornersByHalf={halves}
          onChange={onChangeNotify}
          onChangeCorners={onChangeHalves}
        />
      ) : null}
    </div>
  )
}
