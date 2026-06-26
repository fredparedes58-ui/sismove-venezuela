/**
 * SismoVE · Scraper de fuentes oficiales (terremoto Venezuela)
 * Patrón Krujens (scraping → normalizar → firmar HMAC → webhook).
 *
 * Fuentes:
 *   1. venezuelatebusca.com           → Supabase REST (tabla desaparecidos)   [API abierta]
 *   2. centro-de-acopio-ven.vercel.app → Supabase REST (tabla centros_de_acopio) [API abierta]
 *   3. desaparecidosterremotovenezuela.com → Next.js Server Actions (Playwright, fase 2)
 *
 * Salida:
 *   - data/feed.json       (consumo genérico / debug)
 *   - data/feed.js         (window.SISMOVE_FEED = {...} → el dashboard lo carga sin servidor ni CORS)
 *   - opcional --post      firma HMAC-SHA256 y envía al webhook (SCRAPER_WEBHOOK_URL/SECRET)
 *
 * Uso:
 *   node scraper/scrape.mjs            # raspa y escribe data/feed.*
 *   node scraper/scrape.mjs --post     # además envía al webhook firmado
 *
 * No inventa datos: si una fuente falla, se marca error y se conserva el último feed bueno.
 */
import { createHmac } from 'node:crypto';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'data');

/* ──────────────────────────────────────────────────────────────────────────
   Config de fuentes (descubierta por reconocimiento de los bundles)
   ────────────────────────────────────────────────────────────────────────── */
const SOURCES = {
  vtb: {
    name: 'venezuelatebusca.com',
    url: 'https://ihcnbvkwkiyxlkhuwapu.supabase.co',
    key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImloY25idmt3a2l5eGxraHV3YXB1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIzNDQxNzcsImV4cCI6MjA5NzkyMDE3N30.-0hKS1VFaMFFpnCTzrl4Wj7XwfUVAfos6a0QTGzDtEY',
    bucket: 'fotos-desaparecidos',
    portal: 'https://venezuelatebusca.com/',
  },
  acopio: {
    name: 'centro-de-acopio-ven.vercel.app',
    url: 'https://srfblgjyrqstqdufaaaq.supabase.co',
    key: 'sb_publishable_nvaNAh4LgEHBu0wdCudQFQ_v6YXk6kz',
    portal: 'https://centro-de-acopio-ven.vercel.app/',
  },
  desap: {
    name: 'desaparecidosterremotovenezuela.com',
    portal: 'https://desaparecidosterremotovenezuela.com/',
    note: 'Next.js Server Actions — sin API publica; scraping headless en fase 2.',
  },
};

// Sismos (áreas afectadas) — USGS, sin API key
const USGS = 'https://earthquake.usgs.gov/fdsnws/event/1/query';
const VEN_BBOX = { minlat: 0.5, maxlat: 12.5, minlon: -73.5, maxlon: -59.5 };

// Torres de telefonía — OpenCelliD (requiere OPENCELLID_API_KEY). MCC Venezuela = 734.
const MNC_OPERADORA = { '01': 'Digitel', '02': 'Movilnet', '03': 'Digitel', '04': 'Movistar', '06': 'Movistar' };
const TOWER_BBOXES = [   // [zona, latmin, lonmin, latmax, lonmax] — zonas afectadas/pobladas
  ['Caracas',        10.40, -67.00, 10.55, -66.75],
  ['La Guaira',      10.55, -67.00, 10.65, -66.80],
  ['Valencia',       10.10, -68.10, 10.25, -67.90],
  ['Maracay',        10.20, -67.65, 10.32, -67.50],
  ['Yumare/Yaracuy', 10.55, -68.75, 10.70, -68.55],
  ['San Felipe',     10.28, -68.80, 10.40, -68.65],
  ['Barquisimeto',    9.98, -69.40, 10.12, -69.25],
];

// Estados más afectados (curado de prensa + USGS; geográfico y estable, sin cifras volátiles)
const AREAS_AFECTADAS = {
  evento: 'Doblete sísmico M7.2 + M7.5',
  fecha: '2026-06-24',
  epicentros: ['San Felipe (Yaracuy)', 'Yumare (Yaracuy)'],
  estados: ['La Guaira (zona de desastre)', 'Caracas', 'Miranda', 'Aragua', 'Carabobo', 'Falcón', 'Yaracuy'],
  fuente: 'USGS · prensa (CNN, Telemundo, elDiario.es)',
};

const UA = 'Mozilla/5.0 (SismoVE-scraper; +humanitarian aggregation)';
const TIMEOUT_MS = 20000;

async function getJSON(url, headers) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
    if (!text) throw new Error('respuesta vacia (host inalcanzable o RLS)');
    return JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
}

async function withRetry(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) { last = e; await new Promise(r => setTimeout(r, 800 * (i + 1))); }
  }
  throw last;
}

/* ──────────────────────────────────────────────────────────────────────────
   1) Desaparecidos — venezuelatebusca.com
   ────────────────────────────────────────────────────────────────────────── */
async function scrapeDesaparecidos() {
  const s = SOURCES.vtb;
  const headers = { apikey: s.key, Authorization: `Bearer ${s.key}` };
  const fotoUrl = (foto) =>
    !foto ? '' : String(foto).startsWith('http')
      ? foto
      : `${s.url}/storage/v1/object/public/${s.bucket}/${foto}`;

  const rows = await withRetry(() =>
    getJSON(`${s.url}/rest/v1/desaparecidos?select=*&order=created_at.desc&limit=500`, headers)
  );

  return rows.map(r => ({
    external_id: `vtb:${r.id}`,
    source: 'vtb',
    nombre: [r.nombre, r.apellido].filter(Boolean).join(' ').trim() || 'Sin nombre',
    cedula: r.cedula || null,
    edad: r.edad ?? null,
    zona: r.zona || r.estado_geo || r.ciudad || null,
    estado: (r.estado || 'desaparecido'),
    encontrado: r.estado === 'encontrado',
    foto_url: fotoUrl(r.foto),
    notas: r.notas || null,
    created_at: r.created_at || null,
    portal_url: s.portal,
  }));
}

/* ──────────────────────────────────────────────────────────────────────────
   2) Centros de acopio — centro-de-acopio-ven.vercel.app
   ────────────────────────────────────────────────────────────────────────── */
async function scrapeCentros() {
  const s = SOURCES.acopio;
  const headers = { apikey: s.key };   // publishable key: solo header apikey, sin Bearer
  const rows = await withRetry(() =>
    getJSON(`${s.url}/rest/v1/centros_de_acopio?select=*&order=created_at.desc&limit=500`, headers)
  );

  const arr = (v) => Array.isArray(v) ? v.filter(Boolean) : (v ? [v] : []);
  return rows.map(r => ({
    external_id: `acopio:${r.id}`,
    source: 'acopio',
    nombre: r.responsable || r.nombre || 'Centro de acopio',
    direccion: r.direccion || null,
    telefono: r.telefono || null,
    lat: typeof r.lat === 'number' ? r.lat : (r.latitud ?? null),
    lng: typeof r.lng === 'number' ? r.lng : (r.longitud ?? null),
    necesita: arr(r.necesita),     // articulos prioritarios que faltan
    sobra: arr(r.sobra),
    suministros: arr(r.suministros),
    verificaciones: r.verificaciones ?? 0,
    created_at: r.created_at || null,
    portal_url: s.portal,
  }));
}

/* ──────────────────────────────────────────────────────────────────────────
   3) Sismos / áreas afectadas — USGS (datos reales, sin API key)
   ────────────────────────────────────────────────────────────────────────── */
async function scrapeSismos() {
  const b = VEN_BBOX;
  const start = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const url = `${USGS}?format=geojson&starttime=${start}&minlatitude=${b.minlat}&maxlatitude=${b.maxlat}`
            + `&minlongitude=${b.minlon}&maxlongitude=${b.maxlon}&minmagnitude=2.5&orderby=time&limit=300`;
  const j = await withRetry(() => getJSON(url, { 'User-Agent': UA }));
  return (j.features || []).map(f => {
    const p = f.properties, c = f.geometry.coordinates;
    return { id: f.id, mag: p.mag, place: p.place, lat: c[1], lng: c[0], depth: c[2], time: p.time, url: p.url };
  });
}

/* ──────────────────────────────────────────────────────────────────────────
   4) Torres de telefonía — OpenCelliD (cobertura). Requiere OPENCELLID_API_KEY.
   ────────────────────────────────────────────────────────────────────────── */
async function scrapeTorres() {
  const key = process.env.OPENCELLID_API_KEY;
  if (!key) return { towers: [], note: 'sin OPENCELLID_API_KEY (añádela para ver torres reales)' };
  const seen = new Set(), towers = [];
  for (const [zona, la1, lo1, la2, lo2] of TOWER_BBOXES) {
    try {
      const url = `https://opencellid.org/cell/getInArea?key=${key}&BBOX=${la1},${lo1},${la2},${lo2}&mcc=734&format=json&limit=1000`;
      const j = await getJSON(url, { 'User-Agent': UA });
      for (const c of (j.cells || [])) {
        const id = `${c.mcc}-${c.mnc}-${c.lac}-${c.cellid}`;
        if (seen.has(id)) continue; seen.add(id);
        towers.push({
          lat: c.lat, lng: c.lon,
          operador: MNC_OPERADORA[String(c.mnc).padStart(2, '0')] || `734-${c.mnc}`,
          radio: c.radio || null, range: c.range || null, samples: c.samples || 0, zona,
        });
      }
    } catch { /* sigue con el siguiente recuadro */ }
  }
  return { towers };
}

/* ──────────────────────────────────────────────────────────────────────────
   Construir feed + persistir + (opcional) enviar al webhook
   ────────────────────────────────────────────────────────────────────────── */
async function loadPrevFeed() {
  try { return JSON.parse(await readFile(join(DATA_DIR, 'feed.json'), 'utf8')); }
  catch { return null; }
}

async function postToWebhook(type, source, data) {
  const url = process.env.SCRAPER_WEBHOOK_URL;
  const secret = process.env.SCRAPER_WEBHOOK_SECRET;
  if (!url || !secret) { console.log(`[webhook] omitido (${type}): falta SCRAPER_WEBHOOK_URL/SECRET`); return; }
  const body = JSON.stringify({ type, source, timestamp: new Date().toISOString(), data });
  const sig = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Scraper-Signature': sig },
    body,
  });
  console.log(`[webhook] ${type}: HTTP ${res.status}`);
}

async function main() {
  const post = process.argv.includes('--post');
  const prev = await loadPrevFeed();
  const sources = {};
  let desaparecidos = prev?.desaparecidos ?? [];
  let centros = prev?.centros ?? [];

  // Fuente 1 — desaparecidos
  try {
    desaparecidos = await scrapeDesaparecidos();
    sources.vtb = { ok: true, count: desaparecidos.length, name: SOURCES.vtb.name };
    console.log(`✅ desaparecidos: ${desaparecidos.length}`);
  } catch (e) {
    sources.vtb = { ok: false, error: e.message, name: SOURCES.vtb.name, stale: !!prev };
    console.log(`⚠️  desaparecidos: ${e.message}${prev ? ' (se conserva feed previo)' : ''}`);
  }

  // Fuente 2 — centros de acopio
  try {
    centros = await scrapeCentros();
    sources.acopio = { ok: true, count: centros.length, name: SOURCES.acopio.name };
    console.log(`✅ centros de acopio: ${centros.length}`);
  } catch (e) {
    sources.acopio = { ok: false, error: e.message, name: SOURCES.acopio.name, stale: !!prev };
    console.log(`⚠️  centros: ${e.message}${prev ? ' (se conserva feed previo)' : ''}`);
  }

  // Fuente 3 — desap (referencia; scraping headless en fase 2)
  sources.desap = { ok: null, name: SOURCES.desap.name, note: SOURCES.desap.note, portal: SOURCES.desap.portal };

  // Fuente 4 — sismos / áreas afectadas (USGS)
  let sismos = prev?.sismos ?? [];
  try {
    sismos = await scrapeSismos();
    sources.usgs = { ok: true, count: sismos.length, name: 'USGS' };
    console.log(`✅ sismos: ${sismos.length}`);
  } catch (e) {
    sources.usgs = { ok: false, error: e.message, name: 'USGS', stale: !!prev };
    console.log(`⚠️  sismos: ${e.message}`);
  }

  // Fuente 5 — torres (cobertura). Fuente PRIMARIA = snapshot abierto (scraper/import-towers.mjs).
  // El free tier de getInArea limita el BBOX a 4 km² → no sirve para mapear zonas; por eso NO
  // sobrescribimos las torres del snapshot salvo que se pase --towers-api y devuelva MÁS datos.
  let torres = prev?.torres ?? [];
  if (process.argv.includes('--towers-api')) {
    try {
      const t = await scrapeTorres();
      if (!t.note && t.towers.length > torres.length) torres = t.towers;
      console.log(`ℹ️  torres API: ${t.towers?.length ?? 0} (se conservan ${torres.length})`);
    } catch (e) { console.log(`⚠️  torres API: ${e.message}`); }
  }
  sources.opencellid = torres.length
    ? { ok: true, count: torres.length, name: 'OpenCelliD (snapshot CC-BY-SA)', attribution: 'Datos de torres © OpenCelliD, CC-BY-SA 4.0' }
    : { ok: null, note: 'sin torres — ejecuta scraper/import-towers.mjs', name: 'OpenCelliD' };
  console.log(`📡 torres en feed: ${torres.length}`);

  const encontrados = desaparecidos.filter(d => d.encontrado).length;
  const feed = {
    generated_at: new Date().toISOString(),
    sources,
    areas_afectadas: AREAS_AFECTADAS,
    stats: {
      desaparecidos_total: desaparecidos.length,
      desaparecidos_activos: desaparecidos.length - encontrados,
      encontrados,
      centros_total: centros.length,
      sismos_total: sismos.length,
      torres_total: torres.length,
    },
    desaparecidos,
    centros,
    sismos,
    torres,
  };

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(join(DATA_DIR, 'feed.json'), JSON.stringify(feed, null, 2), 'utf8');
  // feed.js: cargable por el dashboard sin servidor (evita CORS/file://)
  await writeFile(
    join(DATA_DIR, 'feed.js'),
    `/* generado por scraper/scrape.mjs · ${feed.generated_at} */\nwindow.SISMOVE_FEED = ${JSON.stringify(feed)};\n`,
    'utf8'
  );
  console.log(`📦 data/feed.json + data/feed.js escritos (${feed.stats.desaparecidos_total} desap · ${feed.stats.centros_total} centros)`);

  if (post) {
    if (sources.vtb.ok)    await postToWebhook('desaparecidos_sync', 'vtb', desaparecidos).catch(e => console.log('[webhook] err', e.message));
    if (sources.acopio.ok) await postToWebhook('centros_sync', 'acopio', centros).catch(e => console.log('[webhook] err', e.message));
  }
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
