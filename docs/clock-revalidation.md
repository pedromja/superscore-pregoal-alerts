# Revalidação do relógio · SuperScore vs SokkerPro

Gerado: 2026-09-19T14:54:24.317Z. **DEFINITIONS_LOCKED=true** — este relatório não altera janelas nem limiares.

## Porque é que isto existe

O backtest de 18/set (e a aprendizagem) etiquetam golos `type=4` e cantos `type=14` no JSON de momentum SuperScore. Ao vivo esses marcadores chegam tarde. Lead 1–2′ e precisão@lead no dump FT podem estar **optimistamente enviesados** se o `event.min` SuperScore for mais tarde que o golo real, ou se o dump incorporar o evento só depois do pico.

Momentum SuperScore **mantém-se** para disparar alertas. O relógio de verdade, quando existir, é SokkerPro.

## O que a API SokkerPro dá (e não dá)

- Mini `/home/fixtures/{date}/utc/mini`: offline: mini não tem timeline (documentado).
- Detail `/fixture/{id}`: offline: /fixture/{id} timeline conhecido (type 14/16/126).
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
- --offline sem dumps: só sensitivity + gap analysis
- Jogos com timeline SokkerPro: **0**.

Sem amostra emparelhada nesta corrida — não se afirma o enviesamento real do set de 880, só o bound de sensitivity e o desenho prospectivo.

## Estudo prospectivo (já no poller)

- `data/sokker_clock.json` — snapshot do marcador por jogo/tick + transições `score` / `is_goal`.
- Cada `LoggedAlert` ganha `fastScore` + `clockProbe` (não muda hit/label SuperScore).
- Quando houver ≥50 golos em janela com os dois relógios: `npx tsx scripts/revalidate-clock.ts` volta a correr e compara.
- Cantos: não há transição no mini. Ficam **still-suspect** até existir feed de cantos mais rápido.

## Recomendação (Pedro)

**Manter locked. Sem relógio SokkerPro histórico emparelhado não se pode corrigir o backtest — só o estudo prospectivo.**

- Janelas e limiares locked **não** foram alterados. A aprendizagem continua só a propor.
- O gate ao vivo SokkerPro (PR #17) já barre Telegram quando o marcador rápido já bateu.
- Cada alerta ao vivo já grava o snapshot SokkerPro (`is_goal` / marcador) para calibrar daqui para a frente.
- Cantos: o mini board não tem cantos. Relógio de cantos ao vivo continua SuperScore type=14 (ainda suspeito).

Acção: `keep`. Locked intacto. Sem apply silencioso.
