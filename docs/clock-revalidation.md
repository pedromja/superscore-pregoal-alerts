# Revalidação do relógio · SuperScore vs SokkerPro

Gerado: 2026-09-19T14:57:38.282Z. **DEFINITIONS_LOCKED=true** — este relatório não altera janelas nem limiares.

## Porque é que isto existe

O backtest de 18/set (e a aprendizagem) etiquetam golos `type=4` e cantos `type=14` no JSON de momentum SuperScore. Ao vivo esses marcadores chegam tarde. Lead 1–2′ e precisão@lead no dump FT podem estar **optimistamente enviesados** se o `event.min` SuperScore for mais tarde que o golo real, ou se o dump incorporar o evento só depois do pico.

Momentum SuperScore **mantém-se** para disparar alertas. O relógio de verdade, quando existir, é SokkerPro.

## O que a API SokkerPro dá (e não dá)

- Mini `/home/fixtures/{date}/utc/mini`: mini board: só marcador / is_goal / minuto — sem lista de golos ou cantos.
- Detail `/fixture/{id}`: /fixture/{id} timeline com 10 eventos (golos type 14/16, cantos 126).
- **Golos ao vivo:** `scores*` + `is_goal` / `is_goal_team` (já usados no gate Telegram, PR #17).
- **Cantos ao vivo:** o mini **não tem** cantos. Sem feed rápido. Histórico type=126 existe no detail — útil para o estudo offline, **still-suspect** para o live.
- O mini **não** guarda o histórico de golos do jogo; só o marcador actual. Sem `/fixture/{id}` não há minutos.

## Sensitivity no backtest publicado (sem dumps)

Os 2203 JSON do treino **não estão no git**. Enquanto não houver amostra emparelhada, o bound honesto é: se o stamp SuperScore chegar `D` minutos tarde, cada lead `L` vira `L−D`.

| Balde | D | Prec≥1 velha → nova | Prec 1–2 velha → nova | Hits perdidos | Med lead velha → nova |
|---|---:|---:|---:|---:|---:|
| goals_ht | 1′ | 35.3% → 17.7% | 20.7% → 5.1% | 383 (49.9%) | 2 → 4 |
| goals_ht | 2′ | 35.3% → 14.6% | 20.7% → 4.6% | 450 (58.6%) | 2 → 4 |
| goals_ft | 1′ | 37.4% → 21.0% | 19.8% → 5.9% | 349 (43.9%) | 2 → 5 |
| goals_ft | 2′ | 37.4% → 17.6% | 19.8% → 4.8% | 421 (53.0%) | 2 → 5 |
| corners_ht | 1′ | 22.5% → 17.1% | 9.1% → 6.9% | 241 (24.2%) | 3 → 3 |
| corners_ht | 2′ | 22.5% → 13.4% | 9.1% → 6.0% | 403 (40.5%) | 3 → 3 |
| corners_ft | 1′ | 13.2% → 8.3% | 8.5% → 5.8% | 103 (37.1%) | 2 → 2 |
| corners_ft | 2′ | 13.2% → 4.7% | 8.5% → 3.8% | 179 (64.4%) | 2 → 2 |

Leitura rápida (golos HT, D=1′): **35.3% → 17.7%** precisão@lead≥1; **383** dos 768 hits (quase todos os lead=1) deixam de contar. A banda “1–2′” do score locked é a mais frágil.

## Amostra emparelhada SuperScore ↔ SokkerPro

- backtest-data/matches/ vazio (gitignored) — a amostra original de 880 jogos não está no repo
- 2026-09-08: SuperScore FT 200, emparelhados mini 12
- 2026-09-09: SuperScore FT 238, emparelhados mini 12
- 2026-09-10: SuperScore FT 136, emparelhados mini 12
- 2026-09-11: SuperScore FT 316, emparelhados mini 12
- 2026-09-12: SuperScore FT 1147, emparelhados mini 12
- 2026-09-13: SuperScore FT 830, emparelhados mini 12
- 2026-09-14: SuperScore FT 135, emparelhados mini 12
- 2026-09-15: SuperScore FT 182, emparelhados mini 12
- 2026-09-16: SuperScore FT 260, emparelhados mini 12
- 2026-09-17: SuperScore FT 125, emparelhados mini 12
- 2026-09-18: SuperScore FT 311, emparelhados mini 12
- emparelhados com timeline SokkerPro: 113 / 115 dumps
- Jogos com timeline SokkerPro: **113**.
- Offset golo no jogo inteiro (SS − SP, lado+ordem): mediano **4′**, média 4.64, 89.1% com SS ≥1′ mais tarde. Por emparelhar: SS 0 / SP 31. Contagens diferentes = pairing imperfeito — as tabelas por balde (abaixo) é que importam. A amostra é 12 FT/dia emparelhados por nome, **não** os 880 do backtest original.
- Offset canto (histórico type=126, **não** é feed live): mediano **0′**, 46.1% SS mais tarde.

### goals ht

| | Prec (≥1) | Prec (1–2) | Med lead | Alertas | Hits | Coinc. / lead<1 |
|---|---:|---:|---:|---:|---:|---:|
| SuperScore type=4 | 28.1% | 11.1% | 4 | 171 | 48 | 0 / 0 |
| SokkerPro timeline | 21.1% | 4.7% | 5 | 171 | 36 | 12 / 12 |
| Δ | -7.0% | -6.4% | 1 |  |  | colapso 12 (25.0% dos hits SS) |

### goals ft

| | Prec (≥1) | Prec (1–2) | Med lead | Alertas | Hits | Coinc. / lead<1 |
|---|---:|---:|---:|---:|---:|---:|
| SuperScore type=4 | 25.0% | 13.4% | 2 | 172 | 43 | 0 / 0 |
| SokkerPro timeline | 16.9% | 5.8% | 4 | 172 | 29 | 21 / 21 |
| Δ | -8.1% | -7.6% | 2 |  |  | colapso 14 (32.6% dos hits SS) |

### corners ht

| | Prec (≥1) | Prec (1–2) | Med lead | Alertas | Hits | Coinc. / lead<1 |
|---|---:|---:|---:|---:|---:|---:|
| SuperScore type=14 | 23.3% | 11.1% | 3 | 425 | 99 | 0 / 0 |
| SokkerPro timeline | 22.4% | 8.9% | 3 | 425 | 95 | 32 / 32 |
| Δ | -0.9% | -2.1% | 0 |  |  | colapso 5 (5.1% dos hits SS) |

### corners ft

| | Prec (≥1) | Prec (1–2) | Med lead | Alertas | Hits | Coinc. / lead<1 |
|---|---:|---:|---:|---:|---:|---:|
| SuperScore type=14 | 10.2% | 7.1% | 2 | 225 | 23 | 0 / 0 |
| SokkerPro timeline | 8.0% | 6.7% | 2 | 225 | 18 | 12 / 12 |
| Δ | -2.2% | -0.4% | 0 |  |  | colapso 5 (21.7% dos hits SS) |

## Estudo prospectivo (já no poller)

- `data/sokker_clock.json` — snapshot do marcador por jogo/tick + transições `score` / `is_goal`.
- Cada `LoggedAlert` ganha `fastScore` + `clockProbe` (não muda hit/label SuperScore).
- Quando houver ≥50 golos em janela com os dois relógios: `npx tsx scripts/revalidate-clock.ts` volta a correr e compara.
- Cantos: não há transição no mini. Ficam **still-suspect** até existir feed de cantos mais rápido.

## Recomendação (Pedro)

**Manter locked. Considerar apertar o suppress ao vivo (ex. MIN_NOTIFY_LEAD_MIN=2) — só com confirmação do Pedro. Não propor novos limiares ainda.**

- Janelas e limiares locked **não** foram alterados. A aprendizagem continua só a propor.
- O gate ao vivo SokkerPro (PR #17) já barre Telegram quando o marcador rápido já bateu.
- Offset mediano 4′; 29% dos hits SuperScore deixam de ter lead≥1 no relógio SokkerPro.
- Isso invalida a leitura literal do backtest 18/set (prec@lead 1–2). Os params locked foram escolhidos nesse relógio — não os reescrever em silêncio.
- O gate SokkerPro já reduz Telegram tardio. Um piso de 2′ no notify (env) é a alavanca mais segura, sem tocar nas janelas.
- Novos params só depois do estudo prospectivo (log `is_goal` + transições de marcador) e confirmação explícita.
- Cantos: pular revalidação ao vivo até haver feed de cantos mais rápido. Histórico `/fixture/{id}` type=126 fica flagged still-suspect para o live.

Acção: `tighten-notify-suppress`. Locked intacto. Sem apply silencioso.
