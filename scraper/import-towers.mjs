/**
 * SismoVE · Importador de torres reales (OpenCelliD, SIN exponer la API key al cliente)
 *
 * Combina DOS fuentes y genera data/towers.js (window.SISMOVE_TOWERS) + feed.torres:
 *   · data/towers_ve.csv        → snapshot histórico mundial filtrado a MCC 734 (densidad; ~2017)
 *   · data/towers_ve_fresh.csv  → export por país 734 (observadas últimos 18 meses; "recientes")
 *
 * Formato compacto por torre: [lat, lng, opIdx, radioIdx, range, recent(0/1)]
 *   recent=1 → confirmada en los últimos ~18 meses (probablemente activa).
 *
 * Esquema CSV OpenCelliD: radio,mcc,net,area,cell,unit,lon,lat,range,samples,...
 * Uso: node scraper/import-towers.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');

const MNC_OPERADORA = { '01': 'Digitel', '02': 'Movilnet', '03': 'Digitel', '04': 'Movistar', '06': 'Movistar' };
const OP_LIST = ['Movistar', 'Movilnet', 'Digitel', 'Otra'];
const RADIO_LIST = ['GSM', 'UMTS', 'LTE', 'CDMA', 'NR', '?'];
const AFFECTED = { minlat: 9.0, maxlat: 11.3, minlon: -70.2, maxlon: -65.3 };
const FEED_CAP = 6000;
const r5 = n => Math.round(n * 1e5) / 1e5;

function parseFile(name, recent) {
  const path = join(DATA, name);
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const c = line.split(',');
    if (c.length < 10 || c[1] !== '734') continue;       // c[1]=mcc; salta cabecera si la hubiera
    const lng = +c[6], lat = +c[7];
    if (!isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) continue;
    out.push({
      lat, lng,
      operador: MNC_OPERADORA[String(c[2]).padStart(2, '0')] || 'Otra',
      radio: (c[0] || '').replace(/^"|"$/g, '') || '?',
      range: +c[8] || 0,
      samples: +c[9] || 0,
      recent,
    });
  }
  return out;
}

const historico = parseFile('towers_ve.csv', 0);
const frescas = parseFile('towers_ve_fresh.csv', 1);
// Recientes primero para que se dibujen por encima
const towers = [...historico, ...frescas];
const totalVE = towers.length;
const totalRecent = frescas.length;

/* 1) Archivo nacional compacto */
const compact = towers.map(t => [
  r5(t.lat), r5(t.lng),
  Math.max(0, OP_LIST.indexOf(t.operador)),
  Math.max(0, RADIO_LIST.indexOf(t.radio)),
  t.range, t.recent,
]);
writeFileSync(
  join(DATA, 'towers.js'),
  `/* OpenCelliD (CC-BY-SA 4.0) · ${totalVE} torres Venezuela (MCC 734) · ${totalRecent} recientes (≤18m) */\n`
  + `window.SISMOVE_TOWERS_META=${JSON.stringify({ op: OP_LIST, radio: RADIO_LIST })};\n`
  + `window.SISMOVE_TOWERS=${JSON.stringify(compact)};\n`,
  'utf8'
);

/* 2) Subconjunto rápido para el feed (zona afectada; recientes primero, luego por nº de muestras) */
const b = AFFECTED;
let subset = towers.filter(t => t.lat >= b.minlat && t.lat <= b.maxlat && t.lng >= b.minlon && t.lng <= b.maxlon);
subset.sort((x, y) => (y.recent - x.recent) || (y.samples - x.samples));
const cappedFrom = subset.length;
subset = subset.slice(0, FEED_CAP).map(t => ({ lat: t.lat, lng: t.lng, operador: t.operador, radio: t.radio, range: t.range, recent: t.recent }));

let feed;
try { feed = JSON.parse(readFileSync(join(DATA, 'feed.json'), 'utf8')); }
catch { feed = { sources: {}, stats: {}, desaparecidos: [], centros: [], sismos: [], areas_afectadas: null }; }
feed.torres = subset;
feed.stats = feed.stats || {};
feed.stats.torres_total = subset.length;
feed.stats.torres_pais = totalVE;
feed.stats.torres_recientes = totalRecent;
feed.sources = feed.sources || {};
feed.sources.opencellid = { ok: true, count: subset.length, pais: totalVE, recientes: totalRecent, name: 'OpenCelliD (CC-BY-SA)', attribution: 'Datos de torres © OpenCelliD, CC-BY-SA 4.0' };
feed.generated_at = new Date().toISOString();
writeFileSync(join(DATA, 'feed.json'), JSON.stringify(feed, null, 2), 'utf8');
writeFileSync(join(DATA, 'feed.js'), `/* generado por scraper · ${feed.generated_at} */\nwindow.SISMOVE_FEED = ${JSON.stringify(feed)};\n`, 'utf8');

console.log(`✅ towers.js: ${totalVE} torres (${historico.length} históricas + ${totalRecent} recientes ≤18m)`);
console.log(`✅ feed.torres: ${subset.length} (zona afectada, de ${cappedFrom})`);
