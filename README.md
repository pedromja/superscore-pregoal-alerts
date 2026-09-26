# SuperScore · Alertas pré-golo / pré-canto

Painel web (PT-PT) que lê o **attacking momentum** SuperScore e dispara alertas que devem **preceder** o golo ou o canto. Um pico no mesmo minuto do evento é coincidente e **não** conta como acerto.

O cabeçalho tem o filtro de vista **Golos | Cantos** (só muda o que a app mostra; `data/market.json` guarda essa preferência). O servidor avalia, alerta, liquida e aprende **os dois mercados em todos os ticks**, cada um com os seus limiares locked, janelas, ficheiros de aprendizagem e chaves de dedupe.

## Odds observadas (não filtram alertas)

Alertas e avisos Telegram disparam **só** pelas regras de sinal (Spike / Swing / Sustained). **A odd não limita a emissão nem o aviso.** Sem odd ≠ alerta silenciado.

Em cada alerta o poller **observa e regista**:

- **Limite** — mais-um / Over-Under em `current±0,5` (Total goluri / Total cornere, HT quando existir)
- **Asiático** — handicap/total asiático da mesma família, se o SuperScore/Superbet o expuser
- **SokkerPro O/U** — referência pública (não next-goal), a seguir ao SuperScore e antes do RoboBet
- Fallback RoboBet só para a linha `Odd Ao Vivo` (nunca Pre-jogo nem 1X2)

Fica no alerta (`odds`) e no log durável `data/odds_observations.json`, chave `market|half|league`, com timestamp, linha, preços e fonte.

Tip/ROI **anexa** a odd quando existe (stake 1u). Missing odd não cria tip, mas o alerta/Telegram saem na mesma.

Isto é um **overlay futuro** em `data/tip_overlay.json`, **separado** de `params*.json`. **Não** se aplica o overlay de backtest (golos minOdd≥3 / cantos OFF). `requireOdd` / `minOdd` / `maxOdd` por bucket existem para a aprendizagem propor mais tarde — **nunca** entram em vigor sem confirmação explícita na UI/API.

**As regras de odd vêm mais tarde via aprendizagem + confirmação do utilizador.** As regras base Spike/Swing/Sustained, as janelas Golos HT 20–42 / FT 70–90 e as janelas Cantos HT 32–42 / FT 82–87 não mudam em silêncio. Prolongamento (P1>45 / P2>90) está banido.

Fontes SuperScore (não 1X2):

1. **SuperScore (primário)** — o protobuf `OddsApiModel` em `GET /v2/public/stats/offer/market/item?match_id=&app_market=&app_variant=superscore` só traz 1X2 (`name` 1/X/2: `uuid`, `outcome_id`, `price`). Isso **não** é a odd da tip. O `event_id` desse modelo (o mesmo das `odds[]` no fixture) abre os mercados que a UI SuperScore mostra nos tabs de odds, via Superbet offer: `GET https://production-superbet-offer-{ro|pl|br}.freetls.fastly.net/v3/{locale}/events?events={event_id}&includeOnly=fixture,markets,superbets` (SSE em `/v3/subscription/...`). Daí extraímos **Over current+0,5** em Total goluri / Prima repriză - Total goluri, ou Total cornere / Prima repriză - Total cornere. Não se usa 1X2 (`Final`).
2. **SokkerPro O/U (a seguir)** — API pública m2, **sem login**. Não é mercado next-goal / next-canto; é referência Over/Under. Golos: Over `total actual + 0,5` (`BET365_GOLS_OVER_2_5`, valor `1.90#0` → `1.90`). Cantos: Over `total actual + 0,5` ou a linha **CANTO** inteira mais próxima acima (`BET365_CANTO_OVER_9`). O `preodds` vem como lista de snapshots (`created_at`); usamos o mais recente. Prefere `*_LIVE` quando existir. O mini board (~1 MB) tem timeout 25s e cache ~90s, partilhado por todos os jogos do tick; ontem só se hoje carregou e o jogo não estiver lá. Timeouts/404 falham em silêncio (um warn por tick no mini) e o poller continua. `source: sokkerpro` / rótulo `SokkerPro O/U`.
3. **RoboBet Telegram (último fallback de observação)** — linha `Odd Ao Vivo:` (vírgula ou ponto). **Nunca** `Pre-jogo:` nem `Ao Vivo:` (1X2).
4. Sem odd nas três fontes → o alerta e o Telegram **saem na mesma**; só não há linha de tip/ROI.

Não há scrapers de casas. A API HTTP inplay do RoboBet também só tem 1X2 — ignora-se.

### Ponte Telethon → ingest

No bridge Telethon, defina:

```bash
WEBHOOK_URL=https://<host>/api/robobet/ingest
```

`POST` JSON:

```json
{ "texto_alerta": "<mensagem bruta>", "conta": "A" }
```

`conta` A ≈ cantos, B ≈ golos, se o mercado não vier no texto. Também aceita campos já parseados: `{ odd, linha, mercado, liga, jogo }` (além de `text`).

As cotações ingeridas ficam em `data/robobet_tips.json` (máx. ~500). As tips (quando há odd) em `data/tips.json`. Observações em `data/odds_observations.json`. Overlay (inactivo para alertas) em `data/tip_overlay.json`.

ROI (stake 1u binário): **Golos HT, Golos FT, Cantos HT, Cantos FT**. Acerto = evento SuperScore depois do minuto do alerta, dentro do horizonte existente. Follow-up por liga na página Tips / ROI.


Treino de referência (golos): 100 jogos, 737 golos (2026-09-08 → 2026-09-17, Europe/Lisbon). Avaliação ao vivo só nas janelas HT 20–42 / FT 70–90; prolongamento (P1>45 / P2>90) não dispara.
Treino de cantos (janelas): 95 jogos, HT 89 cantos e FT 52 cantos, mesmas datas. Avaliação ao vivo só nas janelas HT 32–42 / FT 82–87. Fora destas janelas a app de cantos não avalia, não envia push e não grava amostras.

## Como correr

```bash
npm install
cp .env.example .env   # opcional; o servidor gera VAPID em data/vapid.json se faltar
npm run vapid:generate # imprime VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY — cole no .env
npm run dev
```

Isto sobe **dois** processos:

| Processo | URL |
|---|---|
| Vite (UI + proxy) | `http://127.0.0.1:43173` |
| API Node (Push + poller + aprendizagem) | `http://127.0.0.1:43174` |

O Vite encaminha `/api/push`, `/api/telegram`, `/api/learn`, `/api/poller`, `/api/robobet` e `/api/tips` para o sidecar.

```bash
npm run build     # Vite UI + bundle do servidor em dist-server/
npm start         # produção: um processo Node (UI + API + poller) em 0.0.0.0:$PORT
```

`npm start` **não** faz o build — espera `dist/` e `dist-server/` já gerados (no Docker isso acontece no stage de build). Para gerar e arrancar localmente: `npm run start:prod`.

## Páginas

1. **Alertas ao vivo** — data (hoje, Europe/Lisbon), região `ro`, poll do momentum, feed, 👍/👎.
2. **Tips / ROI** — tips abertas e liquidadas, ROI por tipo×parte, acompanhamento por liga.
3. **Replay / treino** — amostras Celtic / Drava ou jogo por ID.
4. **Aprendizagem** — precisão/recall, proposta de limiares, histórico, importar amostras.
5. **Definições** — limiares, regras, estado só-leitura do Telegram, notificações locais (Web Push dormente).

## Telegram (avisos ao vivo)

O canal principal é um **bot Telegram**. Quando o poller dispara um alerta Golo/Canto, envia `sendMessage` para o chat configurado (mesmo título/corpo do antigo push, mais o rótulo da regra e um link para o monitor). Web Push fica **desligado** por defeito (`WEB_PUSH_ENABLED` não é `1`); o código de push permanece no repo mas não corre.

Deduplica pelo mesmo `sent.json` / `alertKey` de antes — o mesmo alerta não sai duas vezes. Timeouts ~9s; falhas de rede/API são logadas e o tick continua. Sem `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` o poller corre na mesma e simplesmente não envia.

**Retry do aviso ao vivo.** A 1.ª tentativa continua inline (sem latência extra). Falhas transitórias — erro de rede (`fetch failed`, DNS/ligação), HTTP **429** (espera o `retry_after` do Telegram) e **5xx** — voltam a tentar em background com backoff **2s → 6s → 18s**, no máximo **4 tentativas** e nunca depois de **60s** da primeira (`TELEGRAM_RETRY_MAX_ATTEMPTS`, `TELEGRAM_RETRY_BASE_MS`, `TELEGRAM_RETRY_MAX_AGE_MS`). Outros 4xx e timeouts **não** repetem (num timeout o pedido já foi enviado e pode ter chegado — repetir arriscava mensagem duplicada). Antes de cada retry o **lead gate** corre de novo sobre o snapshot mais recente (mesmo `notifySuppressReason` do envio ao vivo; também desiste se a parte mudou ou o jogo acabou): um aviso cujo lead já expirou nunca é entregue. Uma só cadeia de retry por alerta, e a sent-key reclamada antes da 1.ª tentativa impede reenvios nos ticks seguintes. Contadores em `GET /api/poller/status` → `telegram.retry`.

Quando a aprendizagem marca `hit5` / `hitLong` (`true`|`false`), o servidor tenta um follow-up **🟢 GREEN** (acerto) ou **🔴 RED** (falha) — de preferência `reply_to` à mensagem original (`message_id` gravado em `data/telegram_messages.json` e no alerta). Se o reply falhar, tenta `editMessageText`; senão uma mensagem curta nova. Isto é **best-effort / baixa prioridade**: corre em background, não atrasa o aviso ao vivo nem o attach de odds, e é idempotente (`telegramOutcomeSentAt`). Sem Telegram configurado, salta em silêncio. Não muda janelas nem limiares locked.

Cada aviso leva um botão **Resolver agora**. O clique reavalia o alerta contra o momentum SuperScore actual (ou o último snapshot em disco). Se já houver evento no horizonte → 🟢/🔴 e marca settled. Se ainda for cedo / sem evento → reply `ainda sem resolução` (**nunca** marca vermelho prematuro). O handler é async (webhook `POST /api/telegram/webhook` com `X-Telegram-Bot-Api-Secret-Token`, ou long-poll se o webhook falhar). Chats desconhecidos são ignorados. A validação em lote nas horas mortas (~04:01 PT) continua à parte e não-prioritária.

Health: `GET /api/telegram/status` (`configured`, `enabled`, `lastSendAt`, `lastError` — **sem secrets**). O mesmo bloco entra em `GET /api/poller/status`.

### Variáveis no Railway

No serviço `web` → Variables (nunca no git):

| Variável | Obrigatória | Notas |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | sim, para enviar | Token do [@BotFather](https://t.me/BotFather). **Não commitar.** |
| `TELEGRAM_CHAT_ID` | sim, para enviar | Id do chat/grupo/canal (grupos são negativos, ex. `-100…`) |
| `TELEGRAM_ENABLED` | não | Default **ligado** quando token+chat existem. `0` desliga |
| `TELEGRAM_WEBHOOK_SECRET` | não | Secret do webhook (header Telegram). Se vazio, deriva do bot token |
| `TELEGRAM_UPDATES` | não | `webhook` (default), `poll` (getUpdates) ou `off` |
| `PUBLIC_URL` | não | Origem do link «Abrir no monitor» e do `setWebhook`. Default `https://web-production-837b3.up.railway.app` |
| `WEB_PUSH_ENABLED` | não | Default **desligado**. `1` reactive o Web Push (só se houver subscritores) |

Dashboard: Project → serviço `web` → **Variables** → Raw Editor ou Add. Depois Redeploy. Alternativa CLI (com o projecto ligado):

```bash
railway variables --set "TELEGRAM_BOT_TOKEN=…" --set "TELEGRAM_CHAT_ID=…" --service web
```

### Como obter o chat id

1. No Telegram, abrir [@BotFather](https://t.me/BotFather) → `/newbot` (ou um bot já vosso) → copiar o token.
2. Abrir o bot e enviar `/start`. Para um **grupo**: adicionar o bot, dar permissão para mensagens, e enviar uma mensagem no grupo.
3. No browser (substituir `<token>`):

```
https://api.telegram.org/bot<token>/getUpdates
```

4. No JSON, ler `message.chat.id` (utilizador) ou `message.chat.id` do grupo (normalmente `-100…`). Esse valor é `TELEGRAM_CHAT_ID`.
5. Apagar o token da barra de endereço / histórico. Não o colar no README nem em commits.

Smoke local sem token: `npm test` (o script `scripts/verify-telegram.ts` faz mock do Bot API). Com token só em `.env` local: `POST /api/telegram/test` ou esperar um alerta ao vivo.

## Web Push (dormente)

O poller no servidor (intervalo default **15s**, região `ro`) inclui **todos** os jogos ao vivo que estejam numa janela activa (Golos HT 20–42 / FT 70–90 e/ou Cantos HT 32–42 / FT 82–87) **antes** de qualquer rotação. O `POLLER_LIVE_LIMIT` (default **32**) só limita o fill fora de janela. Jogos em janela correm **primeiro**, com concorrência mais alta (`POLLER_IN_WINDOW_CONCURRENCY`, default **12**); o resto usa `POLLER_CONCURRENCY` (default **8**). Telegram sai assim que o evaluate de cada jogo encontra um alerta — não espera pelo batch nem pelo attach de odds. Timeout por jogo. Corre as regras de **Golos e Cantos** no mesmo tick (o toggle da UI é só vista) e envia **Telegram primeiro** **sem filtro de odd**. Web Push só corre se `WEB_PUSH_ENABLED=1` **e** existirem subscritores. No mesmo instante observa limite e asiático e grava-os. Deduplica por `fixtureId:alertId` (cantos prefixam `corners:`); o mesmo vale para `telegram_messages.json` e ids de tips (`tip-corners-…`), para que um mercado nunca suprima o outro. Registos antigos (sem prefixo) continuam a ser lidos. O primeiro snapshot de um jogo **não** envia aviso. O título começa pelo mercado em singular (`Golo` / `Canto`) e o marcador **Golos casa-fora · Cantos casa-fora**. A prioridade da regra (Primária / Secundária / Reserva) vai no cartão da app e, no Telegram, numa linha extra. Health: `GET /api/poller/status` (`intervalMs`, `inWindowThisTick`, `lastAlertLatencyHint`, `tickInFlight`, `lastTickAt`, `lastHangAt`, `liveProcessed`, `pushSubscribers`, `telegram`).

### Gerar VAPID

```bash
npm run vapid:generate
```

Cole as três linhas no `.env` (ver `.env.example`). A chave **privada** nunca vai para o cliente — o browser só recebe `GET /api/push/vapidPublicKey`.

Se o `.env` estiver vazio, o servidor cria `data/vapid.json` automaticamente (gitignored).

### Subscrever

1. Arrancar `npm run dev`.
2. Definições → **Ativar notificações** (permissão do browser).
3. **Ativar notificações remotas** (`pushManager.subscribe` + `POST /api/push/subscribe`).
4. Opcional: **Teste remoto**.
5. Pode fechar a PWA; o poller continua no Node.

### Android Chrome

1. Abrir o URL → ⋮ → **Adicionar ao ecrã inicial**.
2. Abrir a PWA → Ativar notificações → Ativar notificações remotas.
3. O poller no servidor (PC/VPS) tem de ficar a correr.

### Desktop (Chrome, Edge, Firefox)

Mesmos botões. HTTPS ou `localhost`. Firefox: permitir notificações no site.

### iOS (Safari)

Web Push **só** na PWA do ecrã inicial, iOS 16.4+:

1. Partilhar → **Adicionar ao ecrã inicial**.
2. Abrir pelo ícone (não o separador Safari).
3. Ativar notificações remotas.

No Safari “normal” não há Push.

## Aprendizagem

Cada alerta no servidor: `{id, fixtureId, matchLabel, minute, side, ruleId, features, thresholdsSnapshot, ts, hit5, hitLong, longDeadline, leadTime5, leadTimeLong}`.

Dois horizontes (golo do mesmo lado, estritamente depois do alerta):

| Label na UI | Condição |
|---|---|
| **≤5 min** | `hit5` — golo em `(alertMin, alertMin+5]` |
| **≤15 min ou fim da parte/jogo** | `hitLong` — golo em `(alertMin, min(alertMin+15, fim da parte)]`. 1.ª parte → último minuto period 1 (intervalo). 2.ª parte → último minuto period 2 (FT). Se faltarem mais de 15 min para o fim da parte, o prazo é +15. |

Golos sem pré-alerta no horizonte = misses (recall).

**Recalcular** faz uma grelha leve em torno dos defaults (spike 70–90, swing 40–70, sustained 2–5 / 25–40). O score é **0,4×precisão(≤5 min) + 0,6×precisão(longo)**, com penalização se alertas/jogo > 12. A guarda conservadora (≥1pp precisão sem cair >3pp no recall) usa o **horizonte longo** só para **marcar** a proposta como elegível — **nunca** a aplica sozinha.

O histórico fica em `data/params_history.json` (golos), `data/params_history_corners_ht.json` e `data/params_history_corners_ft.json`. **As regras base não mudam sem confirmação do utilizador** (botão «Aplicar proposta» com checkbox, ou `POST /api/learn/apply` com `{ confirm: true }`). `LEARN_AUTO_APPLY` default `0`; mesmo se `1`, o servidor não escreve `params*.json` em silêncio. Overlay de odd (`data/tip_overlay.json`) é análogo: `PUT /api/tips/overlay` só propõe; `POST /api/tips/overlay/apply` com `confirm: true` activa. Alertas, eventos e parâmetros nunca se misturam entre mercados nem entre HT e FT.

Na Aprendizagem: **Importar amostras Celtic/Drava** para ter métricas imediatamente (no mercado activo).

## Deploy permanente

Um único processo Node 24/7: UI (`dist/`) + `/api/*` (Push, aprendizagem, proxy SuperScore) + poller. O `Dockerfile` é multi-stage (build Vite + bundle do servidor; runtime só corre `npm start` / `node`). Escuta em `0.0.0.0` e na `PORT` que o host injecta.

Um túnel trycloudflare é temporário (horas). Para um URL HTTPS estável use Railway ou Render. **Não** basta o `vercel.json` estático — live monitor, Push e aprendizagem precisam deste processo Node.

### Variáveis de ambiente

Gerar chaves uma vez (`npm run vapid:generate`) e colar as mesmas no host. Sem `VAPID_*` o servidor cria `data/vapid.json` (perde-se no redeploy se o disco for efémero).

| Variável | Default | Notas |
|---|---|---|
| `PORT` | `8080` em produção / `43174` em local | Railway e Render injectam automaticamente |
| `TELEGRAM_BOT_TOKEN` | — | Canal principal. **Não commitar.** Sem isto o poller corre e não envia |
| `TELEGRAM_CHAT_ID` | — | Chat/grupo/canal de destino |
| `TELEGRAM_ENABLED` | on se token+chat | `0` desliga o bot mesmo com credenciais |
| `TELEGRAM_TIMEOUT_MS` | `9000` | Timeout do `sendMessage` |
| `PUBLIC_URL` | URL Railway de produção | Link «Abrir no monitor» nas mensagens |
| `WEB_PUSH_ENABLED` | off | `1` reactive Web Push (dormente) |
| `VAPID_PUBLIC_KEY` | — | Só se reactivar Web Push |
| `VAPID_PRIVATE_KEY` | — | Nunca expor no cliente |
| `VAPID_SUBJECT` | `mailto:dev@localhost` | Use `mailto:` com um email vosso |
| `POLLER_REGION` | `ro` | Região SuperScore. Alias: `POLL_REGION` |
| `POLLER_ENABLED` | `1` | `0` desliga o poller |
| `POLLER_INTERVAL_MS` | `15000` | Intervalo entre ticks. Env ganha sempre (Railway já usa 15000) |
| `POLLER_LIVE_LIMIT` | `32` | Cap do fill **fora de janela**. Jogos em janela entram todos, mesmo acima deste número |
| `POLLER_CONCURRENCY` | `8` | Processors em paralelo para o fill / jogos acabados |
| `POLLER_IN_WINDOW_CONCURRENCY` | `12` | Processors em paralelo para jogos **dentro** de uma janela activa |
| `POLLER_FIXTURE_TIMEOUT_MS` | `12000` | Timeout por jogo — um momentum preso não congela o tick |
| `POLLER_TICK_WATCHDOG_MS` | `80000` | Se o tick não regressar, liberta `inFlight` para o intervalo seguinte |
| `POLLER_JSON_BACKOFF_MAX_MS` | `600000` | Tecto do backoff após JSON vazio/truncado repetido |
| `LEARN_WINDOW` | `5` | Horizonte curto (minutos) |
| `LEARN_AUTO_APPLY` | `0` | `1` só anota a proposta; **nunca** auto-aplica params/overlay |
| `LEARN_AUTO_MIN_OUTCOMES` | `50` | Limiar informativo de elegibilidade (não aplica sozinho) |
| `DATA_DIR` | `data` | Subscriptions, alertas, histórico, `tip_overlay.json` |
| `SOKKERPRO_ODDS` | `1` | `0` desliga o fallback SokkerPro. Timeouts/404 não partem o poller |
| `SOKKERPRO_BOARD_TIMEOUT_MS` | `25000` | Timeout do mini board (~1 MB). Não herda o antigo 6s |
| `SOKKERPRO_PREODDS_TIMEOUT_MS` | `8000` | Timeout por fixture `/preodds`. Alias: `SOKKERPRO_TIMEOUT_MS` |
| `SOKKERPRO_BOARD_CACHE_MS` | `90000` | Cache in-memory do mini de hoje, partilhado no tick |
| `SOKKERPRO_M2_URL` | `https://m2.sokkerpro.com` | Base pública; sem credenciais |
| `NODE_ENV` | `production` | No Docker já vai definido |

Health check: `GET /api/push/status` (JSON `{ subscribers, hasVapid }`). Telegram: `GET /api/telegram/status` (`configured`, `enabled`, `lastSendAt`, `lastError`).

### Railway

1. Criar projecto em [railway.app](https://railway.app) → New → GitHub/Origin repo.
2. O `railway.toml` escolhe o `Dockerfile` e health check `/api/push/status`.
3. Variables → colar `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID` (ver secção Telegram). Opcional: `PUBLIC_URL`, `POLLER_REGION=ro`. `SOKKERPRO_ODDS` default ON (`0` desliga). VAPID só se quiserem `WEB_PUSH_ENABLED=1`.
4. Deploy. Railway define `PORT`. Os avisos saem no Telegram; o URL público (`*.up.railway.app`) serve o monitor e o link das mensagens.
5. Opcional: volume persistente montado em `/app/data` para sent-keys, histórico e (se reactivarem) subscriptions sobreviverem a redeploys.

Sem Docker (Nixpacks): Build `npm ci && npm run build`, Start `npm start`. O `Dockerfile` é o caminho recomendado.

### Render

1. [render.com](https://render.com) → New → Blueprint, ou Web Service apontado a este repo.
2. O `render.yaml` define um web service Docker com health check `/api/push/status`.
3. Environment: as mesmas `VAPID_*` e `POLLER_REGION` (sync: false no blueprint — preencher no dashboard).
4. Deploy. O URL `*.onrender.com` é HTTPS. No plano gratuito o serviço pode adormecer; o poller só corre enquanto a instância estiver acordada.
5. Opcional: disco persistente em `/app/data`.

Manual sem blueprint: Runtime Docker, Dockerfile path `./Dockerfile`, Health Check Path `/api/push/status`.

### Docker local (smoke)

```bash
docker build -t superscore-pregoal .
docker run --rm -p 8080:8080 \
  -e VAPID_PUBLIC_KEY \
  -e VAPID_PRIVATE_KEY \
  -e VAPID_SUBJECT \
  -e POLLER_REGION=ro \
  superscore-pregoal
```

Depois `curl -s http://127.0.0.1:8080/api/push/status`.

## Regras (defaults do treino)

**As regras base não mudam sem confirmação do utilizador.** O overlay de odd não reescreve Spike / Swing / Sustained. Golos só nas janelas HT 20–42 / FT 70–90; cantos só HT 32–42 / FT 82–87. Prolongamento (P1>45 / P2>90) está banido nos dois mercados. Limiares Spike/Swing/Sustained inalterados.

### Golos (default) — só janelas HT 20–42 / FT 70–90

| Regra | Condição |
|---|---|
| **Primária** | `\|v\| ≥ 80` **e** (`\|Δ1\| ≥ 50` **ou** `\|v\| ≥ 30` × 3 min, mesmo lado) |
| **Secundária** | `\|Δ1\| ≥ 60` |
| **Reserva** | `\|v\| ≥ 30` × 4 min, mesmo lado |

Avaliação estrita `alert_minute < goal_minute`. Spike70 sozinho não é regra. Relógio absoluto SuperScore: 1.ª parte 20–42, 2.ª parte **70–90 (não passa de 90)**. **Não há alertas em prolongamento** (`period===1 && min>45` ou `period===2 && min>90`) para golos **nem** cantos. Falha Yeovil 96': o push chegou depois do golo, e já não havia mercados nas casas — stoppage é inútil para tips.

### Cantos (`type=14`) — só janelas HT 32–42 / FT 82–87

`min` é o relógio absoluto do jogo em ambas as partes (a 2.ª começa em 46). Prolongamento (P1>45 / P2>90) fica fora das janelas (hard-ban, mesmo que o relógio venha corrompido).

O minuto ao vivo escolhe o conjunto de parâmetros: 32–42 → HT; 82–87 → FT. Definições mostra as duas metades.

| Janela | W | Primária | Secundária | Reserva |
|---|---|---|---|---|
| **HT 32–42** | 5 | Sustained \|v\|≥30 ×2 | Spike60 ∧ (Swing40 ∨ Sustained3@25) | Sustained \|v\|≥30 ×4 |
| **FT 82–87** | 3 | Spike80 ∧ (Swing50 ∨ Sustained3@30) | Sustained \|v\|≥25 ×2 | Spike \|v\|≥85 |

Aprendizagem: `alerts_corners_ht.json` / `alerts_corners_ft.json` (e params/history/proposal equivalentes). HIT exige `alert_minute < corner_minute` **e** canto na mesma janela. O horizonte curto do FT é 3 min (`hit5` na API continua a ser o horizonte curto).

Golos usam as mesmas regras de sinal, agora só dentro de HT 20–42 / FT 70–90. `POST /api/learn/reset` com `{ confirm: true, market?: "goals"|"corners"|"all" }` limpa alertas, outcomes e propostas; **não** apaga `sent.json`, VAPID/subs nem `tip_overlay.json`.

## APIs SuperScore

- Jogos: proxy `/api/ss-fixtures/by-date/{region}` · `status` 100 ≈ FT · `state` 1 = ao vivo.
- Momentum: `/api/ss-momentum?fixture-id=` · golos `type === 4` · cantos `type === 14` (1=casa, 2=fora).
