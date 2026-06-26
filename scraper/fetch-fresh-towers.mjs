/**
 * SismoVE · Refresco de torres "recientes" (export por país de OpenCelliD, con token)
 *
 * Descarga el export MCC 734 (solo Venezuela, torres observadas en los últimos ~18 meses),
 * lo descomprime (gzip, vía Node) y lo guarda en data/towers_ve_fresh.csv.
 * Luego ejecuta `node scraper/import-towers.mjs` para regenerar towers.js con el flag "reciente".
 *
 * Token: process.env.OPENCELLID_API_KEY o la línea OPENCELLID_API_KEY=... de .env
 * Cron sugerido (diario): node scraper/fetch-fresh-towers.mjs && node scraper/import-towers.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function getKey() {
  if (process.env.OPENCELLID_API_KEY) return process.env.OPENCELLID_API_KEY.trim();
  try {
    const m = readFileSync(join(ROOT, '.env'), 'utf8').match(/^\s*OPENCELLID_API_KEY\s*=\s*(.+)\s*$/m);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

async function main() {
  const key = getKey();
  if (!key) { console.error('❌ Falta OPENCELLID_API_KEY (en .env o variable de entorno).'); process.exitCode = 1; return; }

  const url = `https://opencellid.org/ocid/downloads?token=${key}&type=mcc&file=734.csv.gz`;
  const res = await fetch(url);
  if (!res.ok) { console.error(`❌ Descarga falló: HTTP ${res.status}`); process.exitCode = 1; return; }
  const buf = Buffer.from(await res.arrayBuffer());
  let csv;
  try { csv = gunzipSync(buf).toString('utf8'); }
  catch {
    console.error('❌ La respuesta no es gzip (token inválido o límite diario: 2 descargas/archivo/día).',
      buf.toString('utf8').slice(0, 200));
    process.exitCode = 1; return;
  }
  writeFileSync(join(ROOT, 'data', 'towers_ve_fresh.csv'), csv, 'utf8');
  const n = csv.split('\n').filter(Boolean).length;
  console.log(`✅ towers_ve_fresh.csv actualizado: ${n} torres (export país MCC 734, ≤18 meses).`);
  console.log('   Ahora ejecuta: node scraper/import-towers.mjs');
}
main().catch(e => { console.error('❌', e.message); process.exitCode = 1; });
