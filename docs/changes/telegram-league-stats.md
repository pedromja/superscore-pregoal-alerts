# Telegram: linha de taxa de acerto da liga

Branch `feat/telegram-league-stats` (a partir de `1f782e0`, o merge das edições inline).

## Comportamento

Quando um alerta é enviado, se a liga tiver **pelo menos 3** alertas resolvidos e não VOID no **mesmo mercado**
(golos ou cantos, HT+FT juntos), o texto base leva uma linha antes de "Abrir no monitor":

```
Canto · Golos 0-0 · Cantos 2-2
✅ Filtro
Deportivo Pereira vs Internacional de Bogota · 36' · Fora · v -51
Primária · Sustained |v|≥20 ×2
📊 Liga (cantos): 2/5 · 40 %
Abrir no monitor
💰 Odd …            (edição posterior)
🟢 GREEN · 39'      (edição posterior)
```

Com menos de 3 alertas, não aparece nenhuma linha. Como a linha faz parte do texto base, as edições (odds, VOID,
resultado) mantêm-na. O valor é o do momento do envio e não é atualizado depois.

## Amostra

- Entra todo o alerta guardado das regras bloqueadas (primary/secondary/fallback), quer tenha sido enviado quer
  não: o overlay de qualidade não altera o resultado da regra.
- Conta se tiver `betOutcome` (regra do fim da parte, ver `telegram-bet-outcome.md`). GREEN = `betOutcome.status === 'green'`, a mesma definição do resultado
  no Telegram.
- Ficam de fora: os **VOID**, os não resolvidos, os coincidentes e o próprio alerta.
- Chave da liga: a mesma do seguimento por liga, `leagueKeyOf(fixture.competition)` (trim; vazio = "Sem liga").
  A liga de cada alerta vem do snapshot do jogo (`matches/<id>.json`, `fixture.competition`) e, em último caso,
  de `alert.odds.league`.

## Custo

É um índice em memória (`server/leagueStats.ts`):
- `store.saveMatch` regista jogo → liga;
- `store.saveAlerts` faz o diff da contribuição de cada alerta, por isso settle/VOID/remoção atualizam o índice
  onde são gravados. Só os alertas que mudaram mexem no índice;
- `primeLeagueStats` corre uma vez no arranque, fora do tick (com os dados atuais de produção: ~0,4 s, 1603 jogos).
  Até o índice estar pronto não se mostra nenhuma linha;
- no envio, a consulta é O(1) (~2 µs).

Medido com os dados de produção: `observeAlerts` custa ≤7 ms por gravação de `alerts_corners_ht.json`
(6166 alertas), contra ~90 ms da própria escrita do ficheiro. Nos outros scopes fica abaixo de 1 ms.

## Variáveis

| Var | Default | Efeito |
|---|---|---|
| `TELEGRAM_LEAGUE_STATS` | `1` | `0` desliga a linha |
| `TELEGRAM_LEAGUE_STATS_MIN` | `3` | mínimo de alertas resolvidos para mostrar a linha |

## Notas

- O nome da competição sozinho junta ligas de países diferentes ("Primera Division", "Copa", "Cup"). É a chave
  do seguimento por liga existente. Usar `category + competition` seria mais exato, mas altera essa chave.
- Os alertas contam individualmente: um jogo com vários disparos pesa mais do que um jogo com um só.

Testes: `npm run test:telegram-league-stats`.
