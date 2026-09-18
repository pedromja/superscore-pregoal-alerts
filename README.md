# SuperScore · Alertas pré-golo / pré-canto

Painel web (PT-PT) que lê o **attacking momentum** SuperScore e dispara alertas que devem **preceder** o golo ou o canto. Um pico no mesmo minuto do evento é coincidente e **não** conta como acerto.

O mercado activo escolhe-se no cabeçalho: **Golos | Cantos**. Golos é o default; cantos usam limiares treinados à parte e ficheiros de aprendizagem separados.

Treino de referência (golos): 100 jogos, 737 golos (2026-09-08 → 2026-09-17, Europe/Lisbon).
Treino de cantos: 95 jogos, 873 cantos (`type=14`), mesmas datas.

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

O Vite encaminha `/api/push`, `/api/learn` e `/api/poller` para o sidecar.

```bash
npm run build     # Vite UI + bundle do servidor em dist-server/
npm start         # produção: um processo Node (UI + API + poller) em 0.0.0.0:$PORT
```

`npm start` **não** faz o build — espera `dist/` e `dist-server/` já gerados (no Docker isso acontece no stage de build). Para gerar e arrancar localmente: `npm run start:prod`.

## Páginas

1. **Alertas ao vivo** — data (hoje, Europe/Lisbon), região `ro`, poll do momentum, feed, 👍/👎.
2. **Replay / treino** — amostras Celtic / Drava ou jogo por ID.
3. **Aprendizagem** — precisão/recall, proposta de limiares, histórico, importar amostras.
4. **Definições** — limiares, regras, notificações locais e **Ativar notificações remotas**.

## Web Push (app fechada)

O poller no servidor (intervalo default 45s, região `ro`) busca jogos ao vivo, corre as regras do **mercado activo** e faz `webpush.sendNotification` para as subscriptions guardadas em `data/subscriptions.json`. Deduplica por `fixtureId:alertId` (cantos prefixam `corners:`). O primeiro snapshot de um jogo **não** envia push. Título, corpo e `tag` da notificação identificam o mercado (`pregoal:` vs `precantos:`).

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

**Recalcular** faz uma grelha leve em torno dos defaults (spike 70–90, swing 40–70, sustained 2–5 / 25–40). O score é **0,4×precisão(≤5 min) + 0,6×precisão(longo)**, com penalização se alertas/jogo > 12. A guarda automática (≥1pp precisão sem cair >3pp no recall) usa o **horizonte longo**.

O histórico fica em `data/params_history.json` (golos) e `data/params_history_corners.json` (cantos). Os defaults de treino nunca são substituídos em silêncio. Alertas, eventos e parâmetros nunca se misturam entre mercados.

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
| `LEARN_AUTO_MIN_OUTCOMES` | `50` | Mínimo para auto-aplicar proposta |
| `DATA_DIR` | `data` | Subscriptions, alertas, histórico |
| `NODE_ENV` | `production` | No Docker já vai definido |

Health check: `GET /api/push/status` (JSON `{ subscribers, hasVapid }`).

### Railway

1. Criar projecto em [railway.app](https://railway.app) → New → GitHub/Origin repo.
2. O `railway.toml` escolhe o `Dockerfile` e health check `/api/push/status`.
3. Variables → colar `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, e opcionalmente `POLLER_REGION=ro`.
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

### Golos (default)

| Regra | Condição |
|---|---|
| **Primária** | `\|v\| ≥ 80` **e** (`\|Δ1\| ≥ 50` **ou** `\|v\| ≥ 30` × 3 min, mesmo lado) |
| **Secundária** | `\|Δ1\| ≥ 60` |
| **Reserva** | `\|v\| ≥ 30` × 4 min, mesmo lado |

Avaliação estrita `alert_minute < goal_minute`. Spike70 sozinho não é regra.

### Cantos (`type=14`)

| Regra | Condição |
|---|---|
| **Primária** | `\|v\| ≥ 60` **e** (`\|Δ1\| ≥ 40` **ou** `\|v\| ≥ 25` × 3 min, mesmo lado) |
| **Secundária** | `\|v\| ≥ 20` × 5 min, mesmo lado |
| **Reserva** | `\|v\| ≥ 70` **e** (`\|Δ1\| ≥ 40` **ou** `\|v\| ≥ 25` × 3 min, mesmo lado) |

Não se reutiliza Spike80∧(Swing50∨Sustained3@30) para cantos. Avaliação estrita `alert_minute < corner_minute`.

## APIs SuperScore

- Jogos: proxy `/api/ss-fixtures/by-date/{region}` · `status` 100 ≈ FT · `state` 1 = ao vivo.
- Momentum: `/api/ss-momentum?fixture-id=` · golos `type === 4` · cantos `type === 14` (1=casa, 2=fora).
