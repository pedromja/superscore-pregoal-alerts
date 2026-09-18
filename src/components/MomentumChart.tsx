import type { FiredAlert, GoalEvent, TimelinePoint } from '../lib/types'

type Props = {
  points: TimelinePoint[]
  goals: GoalEvent[]
  alerts: FiredAlert[]
  cursorIndex?: number
  height?: number
}

export function MomentumChart({
  points,
  goals,
  alerts,
  cursorIndex,
  height = 220,
}: Props) {
  if (points.length === 0) {
    return (
      <div className="flex h-52 items-center justify-center rounded-2xl border border-line bg-panel text-sm text-emerald-100/50">
        Sem série de momentum.
      </div>
    )
  }

  const width = Math.max(640, points.length * 8)
  const pad = { t: 18, r: 16, b: 28, l: 36 }
  const innerW = width - pad.l - pad.r
  const innerH = height - pad.t - pad.b
  const x = (i: number) => pad.l + (i / Math.max(1, points.length - 1)) * innerW
  const y = (v: number) => pad.t + ((100 - v) / 200) * innerH
  const zero = y(0)

  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(p.index).toFixed(2)} ${y(p.value).toFixed(2)}`)
    .join(' ')

  const posArea = `${path} L ${x(points[points.length - 1].index).toFixed(2)} ${zero} L ${x(0).toFixed(2)} ${zero} Z`

  const coincidentKeys = new Set(
    goals.map((g) => `${g.period}-${g.min}-${g.index}`),
  )

  return (
    <div className="overflow-x-auto rounded-2xl border border-line bg-panel">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="min-w-full"
        style={{ height }}
        role="img"
        aria-label="Gráfico de attacking momentum"
      >
        <rect width={width} height={height} fill="#0d1814" />
        {[-80, -40, 40, 80].map((tick) => (
          <g key={tick}>
            <line
              x1={pad.l}
              x2={width - pad.r}
              y1={y(tick)}
              y2={y(tick)}
              stroke="#1d332b"
              strokeDasharray="3 4"
            />
            <text
              x={8}
              y={y(tick) + 3}
              fill="#6f8a7c"
              fontSize="10"
              fontFamily="IBM Plex Mono, monospace"
            >
              {tick}
            </text>
          </g>
        ))}
        <line
          x1={pad.l}
          x2={width - pad.r}
          y1={zero}
          y2={zero}
          stroke="#2c4a3e"
        />
        <path d={posArea} fill="url(#mom)" opacity="0.35" />
        <defs>
          <linearGradient id="mom" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#5ee0ff" stopOpacity="0.45" />
            <stop offset="50%" stopColor="#b6f34c" stopOpacity="0.08" />
            <stop offset="100%" stopColor="#ffb020" stopOpacity="0.4" />
          </linearGradient>
        </defs>
        <path d={path} fill="none" stroke="#d7f7c5" strokeWidth="1.6" />

        {goals.map((goal) => (
          <line
            key={`g-${goal.period}-${goal.min}-${goal.index}`}
            x1={x(goal.index)}
            x2={x(goal.index)}
            y1={pad.t}
            y2={height - pad.b}
            stroke={goal.side === 'home' ? '#5ee0ff' : '#ffb020'}
            strokeOpacity="0.55"
            strokeWidth="1.4"
          />
        ))}

        {alerts.map((alert) => {
          const key = `${alert.period}-${alert.min}-${alert.index}`
          const coincident = coincidentKeys.has(key)
          return (
            <circle
              key={alert.id}
              cx={x(alert.index)}
              cy={y(alert.momentum)}
              r={alert.rule === 'primary' ? 4.2 : 3.2}
              fill={coincident ? '#fb7185' : '#b6f34c'}
              stroke="#07110d"
              strokeWidth="1"
            />
          )
        })}

        {cursorIndex !== undefined && points[cursorIndex] && (
          <line
            x1={x(cursorIndex)}
            x2={x(cursorIndex)}
            y1={pad.t}
            y2={height - pad.b}
            stroke="#b6f34c"
            strokeDasharray="4 3"
          />
        )}

        {points
          .filter((_, i) => i === 0 || i === points.length - 1 || points[i].min % 15 === 0)
          .map((p) => (
            <text
              key={`t-${p.index}`}
              x={x(p.index)}
              y={height - 8}
              fill="#6f8a7c"
              fontSize="10"
              textAnchor="middle"
              fontFamily="IBM Plex Mono, monospace"
            >
              {p.min}'
            </text>
          ))}
      </svg>
    </div>
  )
}
