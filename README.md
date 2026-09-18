# SuperScore · Alertas pré-golo

Painel web (PT-PT) que lê o **attacking momentum** SuperScore e dispara alertas que devem **preceder** o golo. Um pico no mesmo minuto do golo é marcado como coincidente e **não** conta como acerto.

Treino de referência: 100 jogos, 737 golos (2026-09-08 → 2026-09-17, Europe/Lisbon).

## Como correr

```bash
npm install
npm run dev
```

O Vite sobe em `http://127.0.0.1:43173` e faz proxy das APIs SuperScore (evita CORS).

```bash
npm run build
npm run preview
```

## Páginas

1. **Alertas ao vivo** — data (default: hoje em Europe/Lisbon), lista de jogos da região `ro` (a usada no treino), poll do momentum, feed de alertas (mais recente primeiro).
2. **Replay / treino** — amostras offline (Celtic vs Ferencváros, Drava Ptuj vs NK Bistrica) ou um jogo terminado por ID/data. Mostra antecedência por golo e picos coincidentes.
3. **Definições** — limiares, toggles de regras e notificações; persistidos em `localStorage`.

## Notificações (PC e telemóvel)

Avisos **locais** via Web Notifications API + Service Worker, enquanto o **monitor está a correr** (separador aberto ou PWA instalada). Não há servidor Push/VAPID nesta fase: se fechar a página, não recebe alertas.

Cada notificação mostra: jogo, minuto, lado (casa/fora), regra e valor de momentum. O clique foca o painel no alerta correspondente (`#/monitor?alert=…`).

O primeiro snapshot de um jogo **não** notifica (evita spam do histórico). Só disparos novos, e não os picos coincidentes com o golo.

Por defeito só a regra **primária** notifica. Secundária e reserva ligam-se em Definições.

### Ativar no PC (Chrome, Edge, Firefox)

1. Abra o painel (`npm run dev` → `http://127.0.0.1:43173`).
2. Clique **Ativar notificações** (canto superior ou Definições).
3. Aceite o pedido do browser.
4. Opcional: **Enviar notificação de teste**.
5. Deixe o separador do monitor aberto (pode estar em segundo plano).

HTTPS ou `localhost` são obrigatórios. Se recusar, volte a permitir no ícone à esquerda da barra de endereço.

### Ativar no Android (Chrome)

1. Abra o URL do painel.
2. Menu ⋮ → **Adicionar à ecrã inicial** (recomendado; o `manifest.webmanifest` já está no projeto).
3. Abra a PWA ou o separador e clique **Ativar notificações**.
4. Mantenha a app/separador aberta para o polling continuar.

### Ativar no iPhone / iPad (Safari)

O iOS **só** entrega notificações web se a app estiver instalada como PWA (iOS 16.4+):

1. Safari → botão Partilhar → **Adicionar ao ecrã inicial**.
2. Abra o ícone (não o separador do Safari).
3. Clique **Ativar notificações** e aceite.
4. Deixe a PWA aberta (mesmo em segundo plano).

No Safari “normal” (sem ecrã inicial) as notificações web não funcionam.

### TODO — Push remoto

Quando for preciso avisar com a página **fechada**: Web Push + VAPID, `push` no Service Worker, e um endpoint que publique o alerta. O `sw.js` atual só trata `SHOW_NOTIFICATION` local e `notificationclick`.

## Regras (defaults do treino)

Momentum assinado ≈ −100…+100 (**+ casa**, **− fora**). O lado do alerta é o sinal do valor.

| Regra | Condição |
|---|---|
| **Primária** (recomendada) | `\|v\| ≥ 80` **e** (`\|Δ1\| ≥ 50` **ou** `\|v\| ≥ 30` durante 3 min no mesmo lado) |
| **Secundária** | `\|Δ1\| ≥ 60` no último minuto |
| **Reserva** | `\|v\| ≥ 30` durante 4 minutos consecutivos, mesmo lado |

Δ1 = diferença face ao ponto anterior da série (amostras de 1 minuto).

**Avaliação:** `alert_minute < goal_minute` (estrito). Janela W = 5 min. Spike70 sozinho **não** é regra — 41% dos golos só têm esse pico no minuto do golo.

Métricas W=5 da primária: precisão 36,6% · recall 33,9% · ~6,9 alertas/jogo · lead mediana 1 min · 33,9% dos golos com pré-alerta em 1–5 min.

## APIs (sem scraping)

- Jogos: `GET /v2/public/stats/fixtures/by-date/{region}?language=en&date=YYYY-MM-DD&timezone_offset=1`  
  Proxy local: `/api/ss-fixtures/...` · região de treino: `ro` · `status` 100 ≈ FT · scores `type` 0 = resultado final · `state` 1 = ao vivo.
- Momentum: `GET /v2/soccer/fixtures/attacking-momentum/superscore/en?fixture-id={id}`  
  Proxy local: `/api/ss-momentum?fixture-id=`  
  Golos: `events` com `type === 4` (`side` 1=casa, 2=fora).

Se a API falhar, o Replay continua a funcionar com as amostras em `public/demo/`.
