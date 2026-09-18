# SuperScore · Alertas pré-golo

Painel web (PT-PT) que lê o **attacking momentum** SuperScore e dispara alertas que devem **preceder** o golo. Um pico no mesmo minuto do golo é coincidente e **não** conta como acerto.

Treino de referência: 100 jogos, 737 golos (2026-09-08 → 2026-09-17, Europe/Lisbon).

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
npm run build
npm run preview   # UI; a API continua a precisar de `npm run dev:api` ou `npm start`
```

## Páginas

1. **Alertas ao vivo** — data (hoje, Europe/Lisbon), região `ro`, poll do momentum, feed, 👍/👎.
2. **Replay / treino** — amostras Celtic / Drava ou jogo por ID.
3. **Aprendizagem** — precisão/recall, proposta de limiares, histórico, importar amostras.
4. **Definições** — limiares, regras, notificações locais e **Ativar notificações remotas**.

## Web Push (app fechada)

O poller no servidor (intervalo default 45s, região `ro`) busca jogos ao vivo, corre as regras e faz `webpush.sendNotification` para as subscriptions guardadas em `data/subscriptions.json`. Deduplica por `fixtureId:alertId`. O primeiro snapshot de um jogo **não** envia push.

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

Cada alerta no servidor: `{id, fixtureId, matchLabel, minute, side, ruleId, features, thresholdsSnapshot, ts}`.

Etiqueta automática (jogo terminado ou replay das amostras): `hit=true` se golo do mesmo lado em `(alertMin, alertMin+W]` (W=5). Golos sem pré-alerta = misses (recall).

**Recalcular** faz uma grelha leve em torno dos defaults (spike 70–90, swing 40–70, sustained 2–5 / 25–40) e maximiza `0.6*precision + 0.4*recall`, com penalização se alertas/jogo > 12.

Aplicação automática só se precisão subir ≥1pp e recall não cair >3pp, e houver ≥50 outcomes (`LEARN_AUTO_MIN_OUTCOMES`). Caso contrário a UI pede **Aplicar proposta**. O histórico fica em `data/params_history.json`. Os defaults de treino nunca são substituídos em silêncio.

Na Aprendizagem: **Importar amostras Celtic/Drava** para ter métricas imediatamente.

## Regras (defaults do treino)

| Regra | Condição |
|---|---|
| **Primária** | `\|v\| ≥ 80` **e** (`\|Δ1\| ≥ 50` **ou** `\|v\| ≥ 30` × 3 min, mesmo lado) |
| **Secundária** | `\|Δ1\| ≥ 60` |
| **Reserva** | `\|v\| ≥ 30` × 4 min, mesmo lado |

Avaliação estrita `alert_minute < goal_minute`. Spike70 sozinho não é regra.

## APIs SuperScore

- Jogos: proxy `/api/ss-fixtures/by-date/{region}` · `status` 100 ≈ FT · `state` 1 = ao vivo.
- Momentum: `/api/ss-momentum?fixture-id=` · golos `type === 4` (1=casa, 2=fora).
