# Telegram: resultado, odds e VOID editados na mensagem original

Branch `feat/telegram-inline-edits` (a partir de `f0217dc`). Só código e testes; **não foi feito deploy**.

## O que muda

1. **Resultado inline.** Quando se carrega em "Resolver agora", e também na notificação automática de settle,
   a mensagem original do alerta é **editada** (`editMessageText`, HTML, links preservados, previews desligadas).
   Acrescenta-se no fim `🟢 GREEN · 39'` ou `🔴 RED · sem golo até 42'`. Não é enviada nenhuma mensagem nova.
   O callback responde com um toast: `Resolvido: GREEN`, `Resolvido: RED`, `ainda sem resolução` (o aviso
   existente de "ainda cedo"), `já resolvido` ou `⚪ VOID · linha já batida ao enviar`. Se a resolução demorar mais de 8 s, responde logo com `A verificar…`, uma única vez.
   Quando o resultado é final, o botão é removido (`reply_markup: {inline_keyboard: []}`).
   Se for cedo demais: só o toast, a mensagem não é editada e o botão fica.
2. **Odds acrescentadas depois.** O envio continua imediato, sem odds no caminho crítico. Quando o `attachOdds`
   termina (SuperScore → SokkerPro → RoboBet TG), a mensagem é editada com
   `💰 Odd +0.5 golos (Over 0.5): 1.85 (SuperScore) · Asiático Over 0.75 1.90 / Under 0.75 1.90`.
   Se não houver odds dentro de `TELEGRAM_ODDS_EDIT_MAX_MS` (90 s), não se acrescenta nada (a opção menos ruidosa).
   As regras das tips não mudam: continuam a exigir odd.
3. **Verificação VOID.** `VOID_CHECK_DELAY_MS` (15 s) depois de um envio bem-sucedido, a app volta a ler o
   momentum do SuperScore e verifica se a linha já estava batida no momento do envio (ver a regra abaixo).
   Se estava: `alert.void = true`, `voidReason`, `voidAt` e `voidCheck` (auditoria), a tip correspondente fica
   `void`, e a mensagem recebe `⚪ VOID · linha já batida ao enviar · golo aos 37'`. O alerta continua guardado.
4. **Composição e ordem.** O texto é sempre reconstruído a partir do estado:
   `texto base` + `linha de odds?` + (`linha VOID` | `linha de resultado`)?. As edições são serializadas por
   alerta (uma fila por `alertKey`). Se o texto não mudou, não há chamada. Um VOID substitui/impede o GREEN/RED.

## Exemplos (alerta de cantos)

```
Canto · Golos 0-0 · Cantos 2-2            <- enviado (com botão "Resolver agora")
✅ Filtro
Deportivo Pereira vs Internacional de Bogota · 36' · Fora · v -51
Primária · Sustained |v|≥20 ×2
Abrir no monitor
💰 Odd +0.5 cantos (Over 4.5): 1.85 (SuperScore) · Asiático Over 4.75 2.02 / Under 4.75 1.80   <- +odds
🟢 GREEN · 39'                             <- resultado (botão removido)
```
Em vez do resultado pode surgir `🔴 RED · sem canto até 45'`, ou `⚪ VOID · linha já batida ao enviar · canto aos 37'`.

## Regra VOID (fontes: SuperScore)

- **Base** = total de eventos do mercado (golos: tipo 4; cantos: tipo 14, **ambos os lados**, porque a linha é
  total + 0.5) até ao minuto do alerta, inclusive. É o placar impresso no alerta (`goalsTally`/`cornersTally`).
- **Relógio do envio** = último ponto do payload de momentum usado no tick que enviou (`sendSnapshot.clockMin/Period`).
  Em retries tardios, usa-se o último payload guardado para o jogo.
- **Eventos frescos**: fetch novo do momentum SuperScore; se falhar, usa-se o snapshot guardado pelo poller
  (`voidCheck.source` = `superscore-fresh` | `superscore-stored`).
- **VOID** se o número de eventos com minuto **estritamente anterior** ao relógio do envio for maior do que a base.
- **Mesmo minuto** do envio (`same-minute`): **não é VOID**. O SuperScore só dá minuto/período, sem timestamp,
  por isso não há forma de provar que o evento foi antes do envio. Fica registado em `voidCheck` para auditoria.
- Sem dados → `no-data`, não é VOID.
- Não altera limiares, janelas, lead gate nem regras do overlay: é só anotação e exclusão das estatísticas.
- A gate mini live-score / `is_goal` do SokkerPro (PR #17) **não está em f0217dc** (só existe como patch em
  `docs/recovery/`), e o `SokkerProFixture` não tem placar. Por isso a verificação usa apenas o SuperScore.
  Quando o PR #17 entrar, pode juntar-se como fonte adicional em `server/telegramVoid.ts`.

## Estatísticas que excluem VOID

- `computeMetrics` (learn summary, green/red, hit rates): `server/learn.ts`
- `overlayStatsFor` (`/api/learn/overlay`, buckets, summary): `server/qualityOverlay.ts`. Ganha o contador `voided`.
- `computeRoi` e `computeLeagueFollowup` (ROI das tips e seguimento por liga): `src/lib/tips.ts`
- Notificações de outcome (`telegramOutcomes`): um alerta VOID nunca recebe GREEN/RED.
- Validação noturna 🟢/🔴: **não existe no código** em f0217dc, por isso não houve nada a alterar.

## Variáveis de ambiente novas

| Var | Default | Efeito |
|---|---|---|
| `TELEGRAM_INLINE_EDITS` | `1` | `0` repõe o comportamento antigo (respostas novas, sem edições) |
| `TELEGRAM_ODDS_EDIT_MAX_MS` | `90000` | janela para acrescentar a linha de odds |
| `VOID_CHECK` | `1` | `0` desliga a verificação VOID |
| `VOID_CHECK_DELAY_MS` | `15000` | atraso da verificação (limitado a 1000–120000) |

## Falhas e compatibilidade

- `message is not modified` conta como sucesso. Outros erros de edição são registados (`lastEditError`) e não se
  repetem (não há retry storm). O processo nunca rebenta por causa disto.
- Resultado: se a edição falhar, faz-se **um** fallback para a resposta antiga (reply 🟢/🔴). Se isso também falhar,
  o claim é libertado como antes.
- Alertas sem `message_id` (antigos, ou sem registo com texto): mantêm o comportamento antigo de resposta.
- Guarda-se no alerta: `telegramMessageId`, `telegramChatId`, `telegramSentAt`, `sendSnapshot`. O registo
  `telegram_messages` ganha `oddsLine`, `resultLine`, `lastEditText`, `finalized`, `editedAt` e `lastEditError`.
- A janela das odds é mantida em memória: num restart dentro dos 90 s, a linha de odds desse alerta perde-se.
  O alerta e as odds continuam guardados.
- As verificações VOID são `setTimeout` em memória: num restart dentro dos 15 s, essa verificação não corre.

## Testes

`npm run test:telegram-inline-edits` (`scripts/verify-telegram-inline-edits.ts`), com a API do Telegram simulada
e sem rede. Foram ajustados os testes existentes `verify-both-markets`, `verify-telegram-retry` e
`verify-quality-overlay` para o novo comportamento (edição em vez de reply).
