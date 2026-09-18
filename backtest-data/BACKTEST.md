# Backtest SuperScore · 18/set/2026

## Dataset

- Ficheiros: `backtest-data/matches/*.json` (2203 jogos com timeline≥80).
- Amostra usada: **880** jogos (máx. 80/dia, preferência a mais golos).
- Datas (Europe/Lisbon): **2026-09-08 → 2026-09-18**.
- Fonte: SuperScore `fixtures/by-date/ro` + `attacking-momentum`. Região `pt`/`uk` devolveu 0 jogos nestas datas.
- Demos Celtic/Drava **não** entram no grid (só verificação).
- Não existe `train_*.py` neste repo. O treino reutiliza `evaluateAlerts` / `rules.ts` (caminho real do poller). Relatórios antigos citavam `train_corners_windowed.py` offline, não commitado.

## Constrangimentos

- Lead útil: **≥ 1 min**. Lead 0 e pós-evento **não** contam.
- Banda preferida para o score: **1–2 min**.
- Prolongamento banido: `P1 min>45` / `P2 min>90`.
- Janelas propostas (absolutas): Golos HT 20–42 / FT 70–90; Cantos HT 32–42 / FT 82–87.

## Resultados por balde

### goals_ht

Janela: **HT 20–42** (period 1, 20–42).

| | Score | Prec (≥1) | Prec (1–2) | Recall | Alertas/jogo | Med lead | Coinc. |
|---|---:|---:|---:|---:|---:|---:|---:|
| Baseline | 0.325 | 32.7% | 17.7% | 46.0% | 3.09 | 2 | 954 |
| Escolhido | 0.338 | 35.3% | 20.7% | 43.3% | 2.47 | 2 | 930 |

- Regras: primária `combo`, secundária `swing`, reserva `sustainedFallback`.
- Limiares: Spike 80, Swing combo 50, Swing sec. 60, Sust 3@30, Sust sec. 5@30, Reserva spike 80 / sust 5@30, W=5.
- Distribuição de lead (escolhido): `{"1":383,"2":67,"3":45,"4":55,"5":34,"6":26,"7":33,"8":26,"9":19,"10":19,"11":10,"12":11,"13":13,"14":13,"15":14}`.

### goals_ft

Janela: **FT 70–90** (period 2, 70–90).

| | Score | Prec (≥1) | Prec (1–2) | Recall | Alertas/jogo | Med lead | Coinc. |
|---|---:|---:|---:|---:|---:|---:|---:|
| Baseline | 0.295 | 35.6% | 17.1% | 47.4% | 3.02 | 3 | 1057 |
| Escolhido | 0.342 | 37.4% | 19.8% | 44.0% | 2.41 | 2 | 1023 |

- Regras: primária `combo`, secundária `swing`, reserva `sustainedFallback`.
- Limiares: Spike 80, Swing combo 50, Swing sec. 60, Sust 3@30, Sust sec. 5@30, Reserva spike 80 / sust 5@30, W=5.
- Distribuição de lead (escolhido): `{"1":349,"2":72,"3":53,"4":48,"5":42,"6":37,"7":25,"8":27,"9":27,"10":31,"11":21,"12":16,"13":25,"14":12,"15":10}`.

### corners_ht

Janela: **HT 32–42** (period 1, 32–42).

| | Score | Prec (≥1) | Prec (1–2) | Recall | Alertas/jogo | Med lead | Coinc. |
|---|---:|---:|---:|---:|---:|---:|---:|
| Baseline | 0.179 | 22.8% | 9.3% | 29.4% | 3.78 | 3 | 499 |
| Escolhido | 0.202 | 22.5% | 9.1% | 38.7% | 5.02 | 3 | 593 |

- Regras: primária `sustained`, secundária `combo`, reserva `sustainedFallback`.
- Limiares: Spike 60, Swing combo 40, Swing sec. 60, Sust 3@25, Sust sec. 2@20, Reserva spike 70 / sust 4@30, W=5.
- Distribuição de lead (escolhido): `{"1":241,"2":162,"3":143,"4":124,"5":103,"6":84,"7":66,"8":51,"9":18,"10":3}`.

### corners_ft

Janela: **FT 82–87** (period 2, 82–87).

| | Score | Prec (≥1) | Prec (1–2) | Recall | Alertas/jogo | Med lead | Coinc. |
|---|---:|---:|---:|---:|---:|---:|---:|
| Baseline | 0.176 | 13.5% | 8.5% | 23.9% | 2.00 | 2 | 226 |
| Escolhido | 0.183 | 13.2% | 8.5% | 27.2% | 2.39 | 2 | 261 |

- Regras: primária `combo`, secundária `sustained`, reserva `spike`.
- Limiares: Spike 80, Swing combo 50, Swing sec. 60, Sust 3@30, Sust sec. 2@20, Reserva spike 85 / sust 4@30, W=3.
- Distribuição de lead (escolhido): `{"1":103,"2":76,"3":46,"4":35,"5":18}`.

## Notas de adopção

Limiares escolhidos em `src/lib/market.ts` (locked):

- **Golos HT/FT:** combo / swing / sustainedFallback; Spike 80, Swing 50/60, Sust 3@30, reserva Sustained **5@30**, W=5. Janelas **20–42** / **70–90**.
- **Cantos HT:** sustained / combo / sustainedFallback; Spike 60, Swing 40/60, Sust 3@25, Sust sec. **2@20**, reserva 70 / 4@30, W=5. Janela **32–42**.
- **Cantos FT:** combo / sustained / spike; Spike 80, Swing 50/60, Sust 3@30, Sust sec. **2@20**, reserva spike 85, W=3. Janela **82–87**.

O grid não melhorou com um shift das janelas (mantêm-se os bounds do brief, sempre ≤42 / ≤90 / ≤87). Prolongamento continua banido.

Definições **locked** (`DEFINITIONS_LOCKED`): a UI avisa Pedro em pt-PT. `PUT /api/learn/params` e `POST /api/learn/apply` exigem `{ confirm: true, unlock: true }`. O poller continua a usar os defaults do código enquanto o lock estiver ligado. Auto-apply permanece desligado.
