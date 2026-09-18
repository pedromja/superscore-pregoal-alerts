# SuperScore · Alertas pré-golo / pré-canto

Painel web (PT-PT) que lê o **attacking momentum** SuperScore e dispara alertas que devem **preceder** o golo ou o canto. Um pico no mesmo minuto do evento é coincidente e **não** conta como acerto.

O mercado activo escolhe-se no cabeçalho: **Golos | Cantos**. Golos é o default; cantos usam limiares treinados à parte e ficheiros de aprendizagem separados.

## Odds observadas (não filtram alertas)

Alertas e Web Push disparam **só** pelas regras de sinal (Spike / Swing / Sustained). **A odd não limita a emissão nem o push.** Sem odd ≠ alerta silenciado.

Em cada alerta o poller **observa e regista**:

- **Limite** — mais-um / Over-Under em `current±0,5` (Total goluri / Total cornere, HT quando existir)
- **Asiático** — handicap/total asiático da mesma família, se o SuperScore/Superbet o expuser
- **SokkerPro O/U** — referência pública (não next-goal), a seguir ao SuperScore e antes do RoboBet
- Fallback RoboBet só para a linha `Odd Ao Vivo` (nunca Pre-jogo nem 1X2)

Fica no alerta (`odds`) e no log durável `data/odds_observations.json`, chave `market|half|league`, com timestamp, linha, preços e fonte.

Tip/ROI **anexa** a odd quando existe (stake 1u). Missing odd não cria tip, mas o alerta/push saem na mesma.

Isto é um **overlay futuro** em `data/tip_overlay.json`, **separado** de `params*.json`. **Não** se aplica o overlay de backtest (golos minOdd≥3 / cantos OFF). `requireOdd` / `minOdd` / `maxOdd` por bucket existem para a aprendizagem propor mais tarde — **nunca** entram em vigor sem confirmação explícita na UI/API.

**As regras de odd vêm mais tarde via aprendizagem + confirmação do utilizador.** As regras base Spike/Swing/Sustained e as janelas Cantos HT 32–42 / FT 82–87 não mudam em silêncio.

Fontes SuperScore (não 1X2):

1. **SuperScore (primário)** — o protobuf `OddsApiModel` em `GET /v2/public/stats/offer/market/item?match_id=&app_market=&app_variant=superscore` só traz 1X2 (`name` 1/X/2: `uuid`, `outcome_id`, `price`). Isso **não** é a odd da tip. O `event_id` desse modelo (o mesmo das `odds[]` no fixture) abre os mercados que a UI SuperScore mostra nos tabs de odds, via Superbet offer: `GET https://production-superbet-offer-{ro|pl|br}.freetls.fastly.net/v3/{locale}/events?events={event_id}&includeOnly=fixture,markets,superbets` (SSE em `/v3/subscription/...`). Daí extraímos **Over current+0,5** em Total goluri / Prima repriză - Total goluri, ou Total cornere / Prima repriză - Total cornere. Não se usa 1X2 (`Final`).
2. **SokkerPro O/U (a seguir)** — API pública m2, **sem login**. Não é mercado next-goal / next-canto; é referência Over/Under. Golos: Over `total actual + 0,5` (`BET365_GOLS_OVER_2_5`, valor `1.90#0` → `1.90`). Cantos: Over `total actual + 0,5` ou a linha **CANTO** inteira mais próxima acima (`BET365_CANTO_OVER_9`). O `preodds` vem como lista de snapshots (`created_at`); usamos o mais recente. Prefere `*_LIVE` quando existir. Timeouts/404 falham em silêncio e o tick do poller continua. `source: sokkerpro` / rótulo `SokkerPro O/U`.
3. **RoboBet Telegram (último fallback de observação)** — linha `Odd Ao Vivo:` (vírgula ou ponto). **Nunca** `Pre-jogo:` nem `Ao Vivo:` (1X2).
4. Sem odd nas três fontes → o alerta e o push **saem na mesma**; só não há linha de tip/ROI.

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


Treino de referência (golos): 100 jogos, 737 golos (2026-09-08 → 2026-09-17, Europe/Lisbon).
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

O Vite encaminha `/api/push`, `/api/learn`, `/api/poller`, `/api/robobet` e `/api/tips` para o sidecar.

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
5. **Definições** — limiares, regras, notificações locais e **Ativar notificações remotas**.

## Web Push (app fechada)

O poller no servidor (intervalo default 45s, região `ro`) busca jogos ao vivo, corre as regras do **mercado activo** e faz `webpush.sendNotification` **sem filtro de odd**. No mesmo instante observa limite e asiático e grava-os. Deduplica por `fixtureId:alertId` (cantos prefixam `corners:`). O primeiro snapshot de um jogo **não** envia push. O título começa pelo mercado em singular (`Golo` / `Canto`) e o marcador **Golos casa-fora · Cantos casa-fora**; a `tag` distingue `pregoal:` vs `precantos:`. A prioridade da regra (Primária / Secundária / Reserva) fica no cartão da app, não no título do push.

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
| `VAPID_PUBLIC_KEY` | — | Obrigatório em produção estável |
| `VAPID_PRIVATE_KEY` | — | Nunca expor no cliente |
| `VAPID_SUBJECT` | `mailto:dev@localhost` | Use `mailto:` com um email vosso |
| `POLLER_REGION` | `ro` | Região SuperScore. Alias: `POLL_REGION` |
| `POLLER_ENABLED` | `1` | `0` desliga o poller |
| `POLLER_INTERVAL_MS` | `45000` | Intervalo entre ticks |
| `LEARN_WINDOW` | `5` | Horizonte curto (minutos) |
| `LEARN_AUTO_APPLY` | `0` | `1` só anota a proposta; **nunca** auto-aplica params/overlay |
| `LEARN_AUTO_MIN_OUTCOMES` | `50` | Limiar informativo de elegibilidade (não aplica sozinho) |
| `DATA_DIR` | `data` | Subscriptions, alertas, histórico, `tip_overlay.json` |
| `SOKKERPRO_ODDS` | `1` | `0` desliga o fallback SokkerPro. Timeouts/404 não partem o poller |
| `SOKKERPRO_TIMEOUT_MS` | `6000` | Timeout por pedido m2 (board / preodds) |
| `SOKKERPRO_M2_URL` | `https://m2.sokkerpro.com` | Base pública; sem credenciais |
| `NODE_ENV` | `production` | No Docker já vai definido |

Health check: `GET /api/push/status` (JSON `{ subscribers, hasVapid }`).

### Railway

1. Criar projecto em [railway.app](https://railway.app) → New → GitHub/Origin repo.
2. O `railway.toml` escolhe o `Dockerfile` e health check `/api/push/status`.
3. Variables → colar `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, e opcionalmente `POLLER_REGION=ro`. `SOKKERPRO_ODDS` default ON (`0` desliga).
4. Deploy. Railway define `PORT`. O URL público (`*.up.railway.app`) é HTTPS — no telemóvel: Definições → **Ativar notificações remotas**.
5. Opcional: volume persistente montado em `/app/data` para subscriptions e histórico sobreviverem a redeploys.

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

**As regras base não mudam sem confirmação do utilizador.** O overlay de odd não reescreve Spike / Swing / Sustained. Cantos continuam só nas janelas HT 32–42 / FT 82–87, mercados Golos e Cantos em paralelo. Limiares Spike/Swing/Sustained dos cantos inalterados.

### Golos (default)

| Regra | Condição |
|---|---|
| **Primária** | `\|v\| ≥ 80` **e** (`\|Δ1\| ≥ 50` **ou** `\|v\| ≥ 30` × 3 min, mesmo lado) |
| **Secundária** | `\|Δ1\| ≥ 60` |
| **Reserva** | `\|v\| ≥ 30` × 4 min, mesmo lado |

Avaliação estrita `alert_minute < goal_minute`. Spike70 sozinho não é regra.

### Cantos (`type=14`) — só janelas HT 32–42 / FT 82–87

`min` é o relógio absoluto do jogo em ambas as partes (a 2.ª começa em 46). Prolongamento (P1>45 / P2>90) fica fora das janelas.

O minuto ao vivo escolhe o conjunto de parâmetros: 32–42 → HT; 82–87 → FT. Definições mostra as duas metades.

| Janela | W | Primária | Secundária | Reserva |
|---|---|---|---|---|
| **HT 32–42** | 5 | Sustained \|v\|≥30 ×2 | Spike60 ∧ (Swing40 ∨ Sustained3@25) | Sustained \|v\|≥30 ×4 |
| **FT 82–87** | 3 | Spike80 ∧ (Swing50 ∨ Sustained3@30) | Sustained \|v\|≥25 ×2 | Spike \|v\|≥85 |

Aprendizagem: `alerts_corners_ht.json` / `alerts_corners_ft.json` (e params/history/proposal equivalentes). HIT exige `alert_minute < corner_minute` **e** canto na mesma janela. O horizonte curto do FT é 3 min (`hit5` na API continua a ser o horizonte curto).

Golos não mudam.

## APIs SuperScore

- Jogos: proxy `/api/ss-fixtures/by-date/{region}` · `status` 100 ≈ FT · `state` 1 = ao vivo.
- Momentum: `/api/ss-momentum?fixture-id=` · golos `type === 4` · cantos `type === 14` (1=casa, 2=fora).
