// Print record counts of a SuperScore data dir: node data-counts.mjs <dataDir>
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
const dir = process.argv[2] || 'data'
const n = (f) => { try { const j = JSON.parse(readFileSync(join(dir, f), 'utf8')); return Array.isArray(j) ? j.length : Object.keys(j).length } catch { return 'missing' } }
const out = {
  goals_ht_alerts: n('alerts.json'), goals_ft_alerts: n('alerts_goals_ft.json'),
  corners_ht_alerts: n('alerts_corners_ht.json'), corners_ft_alerts: n('alerts_corners_ft.json'),
  tips: n('tips.json'), sent: n('sent.json'), telegram_messages: n('telegram_messages.json'),
  matches_files: (() => { try { return readdirSync(join(dir, 'matches')).length } catch { return 'missing' } })(),
}
console.log(JSON.stringify(out))
