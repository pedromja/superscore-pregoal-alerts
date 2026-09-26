import { MARKETS, marketCopy } from '../lib/market'
import type { Market } from '../lib/types'

export function MarketToggle({
  market,
  onChange,
}: {
  market: Market
  onChange: (market: Market) => void
}) {
  return (
    <div
      className="inline-flex rounded-full border border-line bg-pitch p-0.5"
      role="tablist"
      aria-label="Mercado (vista)"
      title="Filtra o que a app mostra. O servidor avalia sempre Golos e Cantos."
    >
      {MARKETS.map((id) => {
        const active = market === id
        const copy = marketCopy(id)
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(id)}
            className={`rounded-full px-3 py-1 text-sm font-semibold ${
              active
                ? 'bg-lime text-pitch'
                : 'text-emerald-100/70 hover:text-emerald-50'
            }`}
          >
            {copy.toggle}
          </button>
        )
      })}
    </div>
  )
}
