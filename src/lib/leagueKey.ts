/**
 * League identity for the league follow-up and the Telegram 📊 line.
 *
 * League names repeat across countries ("Premier League", "Cup", "Primera
 * Division"…), so the key is SuperScore's competition id (`id:<id>`); without
 * it, country + league name (`cn:<country>|<name>`). A bare name is never a key.
 */
export type CompetitionInfo = {
  competitionId?: string | null
  category?: string | null
  competition?: string | null
}

function norm(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** Country + league name key (no id). Null without both parts. */
export function competitionPairKey(info: CompetitionInfo): string | null {
  const cat = (info.category ?? '').trim()
  const comp = (info.competition ?? '').trim()
  if (!cat || !comp) return null
  return `cn:${norm(cat)}|${norm(comp)}`
}

/** Key from the fixture itself: competition id, else country + name, else null. */
export function fixtureLeagueKey(info: CompetitionInfo): string | null {
  const id = (info.competitionId ?? '').trim()
  if (id) return `id:${id}`
  return competitionPairKey(info)
}

const COUNTRY_PT: Record<string, string> = {
  england: 'Inglaterra',
  'england am.': 'Inglaterra (amador)',
  scotland: 'Escócia',
  wales: 'País de Gales',
  'northern ireland': 'Irlanda do Norte',
  ireland: 'Irlanda',
  spain: 'Espanha',
  portugal: 'Portugal',
  france: 'França',
  germany: 'Alemanha',
  'germany am.': 'Alemanha (amador)',
  italy: 'Itália',
  netherlands: 'Países Baixos',
  belgium: 'Bélgica',
  switzerland: 'Suíça',
  austria: 'Áustria',
  'austria am.': 'Áustria (amador)',
  denmark: 'Dinamarca',
  sweden: 'Suécia',
  norway: 'Noruega',
  finland: 'Finlândia',
  iceland: 'Islândia',
  poland: 'Polónia',
  'czech republic': 'Chéquia',
  czechia: 'Chéquia',
  slovakia: 'Eslováquia',
  hungary: 'Hungria',
  romania: 'Roménia',
  bulgaria: 'Bulgária',
  greece: 'Grécia',
  turkey: 'Turquia',
  turkiye: 'Turquia',
  cyprus: 'Chipre',
  croatia: 'Croácia',
  serbia: 'Sérvia',
  slovenia: 'Eslovénia',
  bosnia: 'Bósnia',
  'bosnia & herzegovina': 'Bósnia e Herzegovina',
  albania: 'Albânia',
  'north macedonia': 'Macedónia do Norte',
  montenegro: 'Montenegro',
  ukraine: 'Ucrânia',
  russia: 'Rússia',
  belarus: 'Bielorrússia',
  estonia: 'Estónia',
  latvia: 'Letónia',
  lithuania: 'Lituânia',
  georgia: 'Geórgia',
  armenia: 'Arménia',
  azerbaijan: 'Azerbaijão',
  kazakhstan: 'Cazaquistão',
  israel: 'Israel',
  malta: 'Malta',
  luxembourg: 'Luxemburgo',
  moldova: 'Moldávia',
  brazil: 'Brasil',
  argentina: 'Argentina',
  uruguay: 'Uruguai',
  paraguay: 'Paraguai',
  chile: 'Chile',
  colombia: 'Colômbia',
  peru: 'Peru',
  ecuador: 'Equador',
  bolivia: 'Bolívia',
  venezuela: 'Venezuela',
  mexico: 'México',
  usa: 'EUA',
  'united states': 'EUA',
  canada: 'Canadá',
  'costa rica': 'Costa Rica',
  honduras: 'Honduras',
  guatemala: 'Guatemala',
  'el salvador': 'El Salvador',
  panama: 'Panamá',
  nicaragua: 'Nicarágua',
  jamaica: 'Jamaica',
  japan: 'Japão',
  'south korea': 'Coreia do Sul',
  'korea republic': 'Coreia do Sul',
  china: 'China',
  australia: 'Austrália',
  'new zealand': 'Nova Zelândia',
  india: 'Índia',
  indonesia: 'Indonésia',
  thailand: 'Tailândia',
  vietnam: 'Vietname',
  malaysia: 'Malásia',
  singapore: 'Singapura',
  'saudi arabia': 'Arábia Saudita',
  qatar: 'Catar',
  uae: 'Emirados Árabes Unidos',
  'united arab emirates': 'Emirados Árabes Unidos',
  iran: 'Irão',
  iraq: 'Iraque',
  jordan: 'Jordânia',
  egypt: 'Egito',
  morocco: 'Marrocos',
  algeria: 'Argélia',
  tunisia: 'Tunísia',
  'south africa': 'África do Sul',
  nigeria: 'Nigéria',
  ghana: 'Gana',
  kenya: 'Quénia',
  international: 'Internacional',
  'international clubs': 'Internacional (clubes)',
  world: 'Mundo',
  europe: 'Europa',
  'south america': 'América do Sul',
  'north & central america': 'América do Norte e Central',
  africa: 'África',
  asia: 'Ásia',
}

/** Country as shown in Portuguese when known (else SuperScore's text). */
export function countryLabel(category: string | null | undefined): string {
  const raw = (category ?? '').trim()
  if (!raw) return ''
  return COUNTRY_PT[norm(raw)] ?? raw
}

/** `Inglaterra · Premier League` (or just the name without a country). */
export function leagueDisplayLabel(info: CompetitionInfo): string {
  const comp = (info.competition ?? '').trim() || 'Sem liga'
  const country = countryLabel(info.category)
  return country ? `${country} · ${comp}` : comp
}
