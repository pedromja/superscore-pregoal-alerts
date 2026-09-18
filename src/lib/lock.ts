/** Locked windows + Spike/Swing/Sustained after the 18/Set backtest. */

export const DEFINITIONS_LOCKED = true

export const LOCK_WARNING_PT =
  'Janelas e limiares (Spike / Swing / Sustained) estão bloqueados após o backtest de 18/set. Pedro, não os altere: um alerta com menos de 1 minuto de avanço não dá tempo de entrar no mercado, e o prolongamento (ex. 96\') chega tarde demais. A aprendizagem pode propor, mas não aplica nada em cima destes params sem desbloquear e confirmar. Notificações (ligar/desligar regras) continuam livres.'

export const LOCK_UNLOCK_LABEL_PT =
  'Desbloquear definições (só para experimentar — Pedro, não mexer em produção)'

export const LOCK_SESSION_NOTE_PT =
  'Modo experiência: o poller continua com os defaults locked do código. Recarregar a página restaura os limiares. Gravar no servidor exige confirm + unlock.'

export const LOCK_APPLY_ERROR_PT =
  'Definições bloqueadas. Envie { confirm: true, unlock: true } para aplicar uma proposta. As regras base não mudam em silêncio.'

export const LOCK_SAVE_ERROR_PT =
  'Definições bloqueadas. Envie { confirm: true, unlock: true } para gravar params. O poller usa os defaults locked enquanto DEFINITIONS_LOCKED estiver ligado.'
