# SuperScore · Alertas pré-golo

Painel web (PT-PT) que lê o **attacking momentum** SuperScore e dispara alertas que devem **preceder** o golo. Um pico no mesmo minuto do golo é marcado como coincidente e **não** conta como acerto.

Treino de referência: 100 jogos, 737 golos (2026-09-08 → 2026-09-17, Europe/Lisbon).

## Como correr

```bash
npm install
npm run dev
```

O Vite sobe em `http://127.0.0.1:43173` e faz proxy das APIs SuperScore (evita CORS).

```bash
npm run build
npm run preview
```

## Páginas

1. **Alertas ao vivo** — data (default: hoje em Europe/Lisbon), lista de jogos da região `ro` (a usada no treino), poll do momentum, feed de alertas (mais recente primeiro).
2. **Replay / treino** — amostras offline (Celtic vs Ferencváros, Drava Ptuj vs NK Bistrica) ou um jogo terminado por ID/data. Mostra antecedência por golo e picos coincidentes.
3. **Definições** — limiares e toggles; persistidos em `localStorage`.

## Regras (defaults do treino)

Momentum assinado ≈ −100…+100 (**+ casa**, **− fora**). O lado do alerta é o sinal do valor.

| Regra | Condição |
|---|---|
| **Primária** (recomendada) | `\|v\| ≥ 80` **e** (`\|Δ1\| ≥ 50` **ou** `\|v\| ≥ 30` durante 3 min no mesmo lado) |
| **Secundária** | `\|Δ1\| ≥ 60` no último minuto |
| **Reserva** | `\|v\| ≥ 30` durante 4 minutos consecutivos, mesmo lado |

Δ1 = diferença face ao ponto anterior da série (amostras de 1 minuto).

**Avaliação:** `alert_minute < goal_minute` (estrito). Janela W = 5 min. Spike70 sozinho **não** é regra — 41% dos golos só têm esse pico no minuto do golo.

Métricas W=5 da primária: precisão 36,6% · recall 33,9% · ~6,9 alertas/jogo · lead mediana 1 min · 33,9% dos golos com pré-alerta em 1–5 min.

## APIs (sem scraping)

- Jogos: `GET /v2/public/stats/fixtures/by-date/{region}?language=en&date=YYYY-MM-DD&timezone_offset=1`  
  Proxy local: `/api/ss-fixtures/...` · região de treino: `ro` · `status` 100 ≈ FT · scores `type` 0 = resultado final · `state` 1 = ao vivo.
- Momentum: `GET /v2/soccer/fixtures/attacking-momentum/superscore/en?fixture-id={id}`  
  Proxy local: `/api/ss-momentum?fixture-id=`  
  Golos: `events` com `type === 4` (`side` 1=casa, 2=fora).

Se a API falhar, o Replay continua a funcionar com as amostras em `public/demo/`.
