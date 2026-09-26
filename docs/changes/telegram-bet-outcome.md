# Resultado da aposta no fim da parte (betOutcome) + odd da linha certa

## Regra (GREEN/RED mostrado no Telegram e contado nas estatísticas)

A aposta é "+0.5" no total do mercado. Contam os eventos das DUAS equipas (cantos tipo 14, golos tipo 4).

- **Linha base** = total impresso no alerta (`sendSnapshot.totalAtAlert`). Se não existir, usa os eventos até ao minuto
  do alerta. Usa-se o maior dos dois: um evento que já estava no placar impresso nunca conta como GREEN, e um tally
  atrasado nunca transforma um evento anterior ao alerta em GREEN.
- **Alvo**: alertas HT vão até ao apito do intervalo (período 1, com descontos: 47' = 45+2). Alertas FT vão até ao apito
  final (período 2, com descontos: 94' = 90+4). O prolongamento nunca conta.
- **GREEN** logo que o total ultrapassa a linha base. Texto: `🟢 GREEN · canto aos 45+2'`.
- **RED** só quando a parte está confirmada como terminada:
  - aparecem dados de um período posterior (HT: timeline/eventos da 2.ª parte), ou
  - o jogo está terminado (state 2 / status ≥ 100 / `finished`).

  O relógio (42' / 45' / 90') nunca decide RED. Texto: `🔴 RED · sem canto até ao intervalo (45+2')` /
  `🔴 RED · sem golo até ao fim (90+5')`. O minuto de descontos aparece quando é conhecido.
- **Sem confirmação**:
  - `stale`: o feed está parado há ≥30 min, o relógio está ≥45'/90' e não há período seguinte. Decide com a última
    contagem conhecida.
  - `timeout`: 4 h após o pontapé de saída.
- **Sem cobertura**: se o feed não tem nenhum evento para o jogo (algumas ligas, p.ex. "Liga 3 Superscore"), fica por
  decidir. Nunca é RED.
- **VOID**: igual ao que já existia. Fica fora de tudo e nunca recebe GREEN/RED.

Fica guardado em `LoggedAlert.betOutcome` e `Tip.betOutcome`:
`{status, rule:'half-end-v1', baseline, total, targetPeriod, event, endMin, reason, decidedAt}`.
Os rótulos de aprendizagem (`hit5`/`hitLong`, horizontes ≤5/15 min) e `computeMetrics` ficam **inalterados**. O mesmo
vale para thresholds, janelas e regras do overlay.

## Onde é usado

- Edição do resultado no Telegram (`formatTelegramResultLine`) e notificação de outcome (`telegramOutcomes`). O
  `labelMatch` já não dispara Telegram. Os outcomes automáticos só vão para alertas enviados há ≤12 h.
- Stats do overlay (`qualityOverlay.bucket`), resumo `bet` em `/api/learn/summary`, linha 📊 da liga (`leagueStats`).
- Tips: `settleTipsForMatch` (a cada tick) e `settleTipsByBet` decidem pela mesma regra. Status e pnl seguem o
  betOutcome. `legacyStatus` guarda o valor anterior quando muda. O ROI e o acompanhamento por liga ficam, portanto,
  na regra nova.
- "Resolver agora":
  - GREEN/RED imediato, se já estiver decidido;
  - caso contrário, o toast `ainda sem resolução (parte a decorrer)`, sem edição.

## Liquidação

- `server/betIndex.ts`: índice de alertas por decidir (≤24 h) por âmbito. É alimentado por `saveAlerts`.
- `server/betSettle.ts`:
  - `noteBetCandidate` é chamado em cada `saveMatch` do poller.
  - `flushBetSettlements` corre uma vez por tick, sob o lock. Só lê/grava o ficheiro de um âmbito quando algum
    alerta pendente pode ser decidido (custo medido: 3–5 ms).
  - Faz também um sweep de jogos já fora do feed a cada 5 min.
- **Arranque**:
  1. `resettleAllBets()` recalcula todos os alertas/tips sem betOutcome e escreve
     `data/bet_resettle_report.json`.
  2. Depois é construído o índice da liga.
  3. Por fim, `runResettleEdits` edita as mensagens enviadas nas últimas 48 h com o resultado corrigido: em série,
     cerca de 1 edição a cada 1,1 s, sem mensagens novas e sem fallback de resposta.
- Estimativa com a cópia de produção de 23:27 PT: 9 898 alertas decididos (5 852 🟢 / 4 046 🔴), dos quais 202
  passaram de RED para GREEN, 0 de GREEN para RED e 9 426 não estavam resolvidos antes. Há 678 mensagens para editar
  (48 h; 22 passam de RED para GREEN, 617 não tinham resultado). Tips: 449 passaram de lost para won e 12 de won para
  lost (o placar impresso no envio já incluía o evento).

## Odd (+0.5) da linha e do período certos

Causa do caso "Penarol vs Boston River, HT 36', 3 cantos → Over 3.5 @10.50":

- O picker aceitava qualquer mercado com "cornere" no nome. Escolheu `Prima repriză - Total cornere CA Penarol`, que é
  o total de cantos DE UMA EQUIPA: 4.º canto do Penarol, daí 10.50.
- O "asiático" era `Handicap cornere` (handicap).
- Também caía para mercados do jogo inteiro nos alertas HT e tratava `A doua repriză` (só 2.ª parte) como FT.
- Aceitava a linha total−0.5 e linhas "mais próximas".
- O SokkerPro caía da chave HT para a do jogo inteiro e aceitava preços pré-jogo.

Agora:

- **SuperScore**: só o total do jogo para o mercado (`Total cornere` / `Total goluri`). Alerta HT → só
  `Prima repriză - Total …`. Alerta FT → só o mercado sem prefixo (jogo inteiro). Totais de equipa, handicaps e
  2.ª parte são rejeitados. Só a linha exata total+0.5.
- **Asiático**: só `Total … asiatice` do mesmo período, par over/under da linha mais baixa acima do total (≤ total+1).
- **SokkerPro**: só chaves `_LIVE` do período certo e da linha exata. As chaves `2T` são ignoradas.
- **RoboBet**: só se a metade coincidir e a linha for exatamente total+0.5.
- `maisUmPriceOf` volta a validar as observações guardadas: as antigas e erradas deixam de aparecer e deixam de
  servir de odd de tip.
- Sem mercado certo, não aparece nenhuma linha 💰. As odds não filtram alertas.

## Testes

`npm run test:telegram-bet-outcome`:

- GREEN aos 45+2 e aos 90+4;
- pendente durante a parte e nos descontos;
- RED só depois da 2.ª parte ou do fim;
- stale/timeout;
- as duas equipas contam;
- prolongamento e eventos do outro mercado não contam;
- sem cobertura, fica pendente;
- rótulos e métricas de aprendizagem inalterados;
- overlay, ROI de tips e linha da liga usam o betOutcome;
- re-settle idempotente, com edições espaçadas e sem sendMessage;
- odds do caso Penarol.

Os testes existentes foram ajustados à regra nova.
