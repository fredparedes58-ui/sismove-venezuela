/**
 * SismoVE · Auto-OCR + CLASIFICACIÓN de imágenes/PDFs del Drive → Supabase (Gemini Vision)
 *
 * Recorre todas las carpetas (+ subcarpetas) recursivamente, detecta imágenes/PDFs aún NO
 * procesados (tabla foto_ocr), y por cada uno Gemini CLASIFICA y EXTRAE → rutea a su tabla:
 * Clasifica CUALQUIER imagen/PDF del Drive y la enruta sola a su destino:
 *   cartel desaparecido/rescatado → desaparecidos_reportes (foto del cartel; rescatado=encontrado;
 *                                   menores → categoria 'nino')
 *   lista de pacientes de hospital → hospital_admisiones
 *   directorio de acopio           → centros_acopio_external
 *   necesidades / insumos que faltan → logistica_reports (geocodificado para el mapa)
 *   daños (colapso/grietas/inundación/vía/incendio) → zona_reports (geocodificado)
 *   grupo/canal comunitario (WhatsApp/Telegram) → grupos_comunitarios
 *   otro (meme, foto sin datos)     → se ignora
 * SIEMPRE redacta cédula/documento. Marca cada archivo en foto_ocr para no repetir.
 * 1 archivo por llamada (tiempo/cuota Gemini). Throttle 10 min. `?file=<id>&key=` procesa uno puntual.
 *
 * Requiere env: GEMINI_API_KEY (free), SCRAPER_WEBHOOK_SECRET. Modelo: GEMINI_MODEL (def gemini-2.5-flash).
 */
export const config = { runtime: 'edge' };

const SB = process.env.SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const GEMINI = process.env.GEMINI_API_KEY;
const FOLDERS = (process.env.DRIVE_FOLDER_IDS || process.env.DRIVE_FOLDER_ID || '1o36ifaRz45kAs5rKzci49aD0mP5JB_YI,1OIUMzrZzRpcTTE8olKT0lk6-jRFO3ztM').split(',').map(s => s.trim()).filter(Boolean);
const MAX_DEPTH = 4, MAX_FOLDERS = 80;
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const MAX_PER_RUN = 1;        // 1 por invocación (PDFs lentos → evitar timeout del Edge)
const THROTTLE_MIN = 10;
const ENTRY_RE = /<div class="flip-entry"[^>]*id="entry-([^"]+)"[\s\S]*?<a href="([^"]+)"[\s\S]*?<div class="flip-entry-title">([^<]*)<\/div>/g;

function sbH(extra: Record<string, string> = {}) {
  return { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...extra };
}
function tipoOf(url: string, name: string): string {
  if (url.includes('/drive/folders/')) return 'carpeta';
  if (/\.(jpe?g|png|webp|heic)$/i.test(name)) return 'imagen';
  if (/\.pdf$/i.test(name)) return 'pdf';
  return 'otro';
}
async function listFolder(id: string) {
  const html = await (await fetch(`https://drive.google.com/embeddedfolderview?id=${id}#list`, { headers: { 'User-Agent': 'Mozilla/5.0 (SismoVE)' } })).text();
  const out: any[] = []; let m: RegExpExecArray | null; ENTRY_RE.lastIndex = 0;
  while ((m = ENTRY_RE.exec(html)) !== null) { const name = m[3].trim(); if (name) out.push({ id: m[1], name, url: m[2], tipo: tipoOf(m[2], name) }); }
  return out;
}
// Recorre TODAS las carpetas (FOLDERS) recursivamente; el "hospital" es el nombre de la
// carpeta contenedora (para datos sueltos en raíz queda 'Drive'/'PDF').
async function allFiles() {
  const files: { id: string; hospital: string; tipo: string }[] = [];
  const seenFolders = new Set<string>(); let visited = 0;
  const queue: { id: string; name: string; depth: number }[] = FOLDERS.map(id => ({ id, name: 'Drive', depth: 0 }));
  while (queue.length && visited < MAX_FOLDERS) {
    const { id, name, depth } = queue.shift()!;
    if (seenFolders.has(id)) continue; seenFolders.add(id); visited++;
    let entries: any[] = [];
    try { entries = await listFolder(id); } catch { continue; }
    for (const it of entries) {
      if (it.tipo === 'carpeta') { if (depth < MAX_DEPTH && !seenFolders.has(it.id)) queue.push({ id: it.id, name: it.name, depth: depth + 1 }); }
      else if (it.tipo === 'imagen' || it.tipo === 'pdf') files.push({ id: it.id, hospital: it.tipo === 'pdf' ? 'PDF' : (name === 'Drive' ? 'Drive' : name), tipo: it.tipo });
    }
  }
  const seen = new Set<string>();
  return files.filter(f => seen.has(f.id) ? false : (seen.add(f.id), true));
}
function toBase64(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf); let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000) as any);
  return btoa(s);
}
// ── Saneo / redacción (cédula nunca se guarda) ──
const DOC_RE = /[vejpg][-\s.]?\d{1,2}[.\s]?\d{3}[.\s]?\d{3}|\d{1,3}[.\s]\d{3}[.\s]\d{3}|(?:c[ií]|c\.i|cedula|cédula|dni|documento|pasaporte|rif)\b[:\s.\-]*[\w.\-]*\d{5,}/gi;
const redact = (s: any) => String(s || '').replace(DOC_RE, ' ').replace(/\d{6,}/g, ' ').replace(/\s{2,}/g, ' ').trim();
const cleanPhone = (s: any) => { const m = String(s || '').match(/(\+?58[\s-]?)?0?4\d{2}[\s.-]?\d{3}[\s.-]?\d{4}|\b0?2\d{2}[\s.-]?\d{3}[\s.-]?\d{4}\b/g); return m ? Array.from(new Set(m.map(x => x.trim()))).join(' / ').slice(0, 60) : ''; };
const norm = (s: any) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const thumb = (id: string) => `https://drive.google.com/thumbnail?id=${id}&sz=w1000`;
const isMinor = (edad: any) => { if (/mes|meses|d[ií]a/i.test(String(edad || ''))) return true; const m = String(edad || '').match(/\d{1,3}/); return m ? parseInt(m[0], 10) <= 14 : false; };

// ── Geocodificación para logística (ubicar el punto en el mapa) ──
// Gazetteer VE (ciudad/estado → [lat,lng]) primero (instantáneo); si no, Nominatim (best-effort).
const GAZ: Record<string, [number, number]> = {
  caracas: [10.4806, -66.9036], 'distrito capital': [10.4806, -66.9036], libertador: [10.4806, -66.9036],
  petare: [10.4769, -66.8131], 'los teques': [10.3439, -67.0419], guarenas: [10.4719, -66.6111], guatire: [10.4719, -66.5419],
  'la guaira': [10.6000, -66.9337], vargas: [10.6000, -66.9337], maiquetia: [10.5990, -66.9810], 'catia la mar': [10.6010, -67.0290],
  maracaibo: [10.6545, -71.6406], zulia: [10.6545, -71.6406], cabimas: [10.3937, -71.4476],
  valencia: [10.1620, -68.0077], carabobo: [10.1620, -68.0077], 'puerto cabello': [10.4731, -68.0125], guacara: [10.2306, -67.8772], naguanagua: [10.2400, -68.0150],
  maracay: [10.2469, -67.5958], aragua: [10.2469, -67.5958], turmero: [10.2289, -67.4742], cagua: [10.1864, -67.4608], 'la victoria': [10.2272, -67.3320],
  barquisimeto: [10.0647, -69.3470], lara: [10.0647, -69.3470], cabudare: [10.0339, -69.2625], carora: [10.1736, -70.0814],
  'san felipe': [10.3399, -68.7407], yaracuy: [10.3120, -68.7400], yaritagua: [10.0814, -69.1278], chivacoa: [10.1614, -68.9006], nirgua: [10.1497, -68.5681],
  'ciudad guayana': [8.3533, -62.6528], 'puerto ordaz': [8.2964, -62.7186], 'ciudad bolivar': [8.1222, -63.5497], bolivar: [8.1222, -63.5497],
  'san cristobal': [7.7669, -72.2250], tachira: [7.7669, -72.2250],
  maturin: [9.7457, -63.1832], monagas: [9.7457, -63.1832],
  cumana: [10.4541, -64.1668], sucre: [10.4541, -64.1668], carupano: [10.6678, -63.2581],
  barcelona: [10.1357, -64.6857], 'puerto la cruz': [10.2147, -64.6328], anzoategui: [10.1357, -64.6857], 'el tigre': [8.8892, -64.2530], anaco: [9.4307, -64.4633],
  merida: [8.5972, -71.1448], 'el vigia': [8.6131, -71.6539],
  'punto fijo': [11.6986, -70.1997], coro: [11.4045, -69.6734], falcon: [11.4045, -69.6734],
  acarigua: [9.5597, -69.2019], araure: [9.5667, -69.2278], guanare: [9.0419, -69.7421], portuguesa: [9.0419, -69.7421],
  valera: [9.3185, -70.6036], trujillo: [9.3700, -70.4339], barinas: [8.6226, -70.2075],
  porlamar: [10.9577, -63.8486], 'nueva esparta': [10.9577, -63.8486], 'la asuncion': [11.0333, -63.8628],
  'san juan de los morros': [9.9088, -67.3547], calabozo: [8.9242, -67.4279], guarico: [9.9088, -67.3547],
  miranda: [10.2500, -66.6000], cojedes: [9.6612, -68.5862], 'san carlos': [9.6612, -68.5862],
  apure: [7.8979, -67.4729], 'san fernando': [7.8979, -67.4729], amazonas: [5.6639, -67.6236], 'puerto ayacucho': [5.6639, -67.6236],
  'delta amacuro': [9.0606, -62.0489], tucupita: [9.0606, -62.0489],
};
async function geocodeVE(q: string): Promise<{ lat: number; lng: number } | null> {
  const text = (q || '').trim(); if (!text) return null;
  const n = norm(text);
  // 1) gazetteer: la ciudad/estado de mayor longitud que aparezca en el texto (evita falsos "coro" dentro de palabras)
  let best: [number, number] | null = null, bestLen = 0;
  for (const key of Object.keys(GAZ)) { if (key.length > bestLen && new RegExp(`\\b${key.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`).test(n)) { best = GAZ[key]; bestLen = key.length; } }
  if (best) return { lat: best[0], lng: best[1] };
  // 2) Nominatim (VE), best-effort con timeout corto
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=ve&q=${encodeURIComponent(text)}`, { headers: { 'User-Agent': 'SismoVE/1.0 (humanitarian earthquake response)' }, signal: ctrl.signal });
    clearTimeout(t);
    const j: any = await r.json();
    if (Array.isArray(j) && j[0]) { const lat = parseFloat(j[0].lat), lng = parseFloat(j[0].lon); if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng }; }
  } catch {}
  return null;
}
// Deduce las categorías de recurso (comida/agua/…) del texto de necesidades, para el ícono del mapa.
function tipoFromNeeds(s: string): string {
  const n = norm(s); const out: string[] = [];
  if (/comida|aliment|viver|comestible|merienda|enlatad/.test(n)) out.push('comida');
  if (/agua|hidrat/.test(n)) out.push('agua');
  if (/medicin|medicament|f[aá]rmac|insulina|antibi|suero|gasa|curita/.test(n)) out.push('medicinas');
  if (/pa[nñ]al|higien|jab[oó]n|toalla|aseo|cloro|cepillo|champ/.test(n)) out.push('higiene');
  if (/ropa|cobij|manta|colch|zapato|calzado|abrigo/.test(n)) out.push('ropa');
  if (/volunt|manos|personal|rescatist/.test(n)) out.push('voluntarios');
  return out.length ? Array.from(new Set(out)).join(',') : 'otro';
}

// Mapea texto libre al conjunto cerrado de valores que esperan las tablas.
function mapZonaTipo(s: string): string {
  const n = norm(s);
  if (/colaps|derrumb|caid|desplom/.test(n)) return 'colapso';
  if (/griet|fisur|estructural|raja/.test(n)) return 'grietas';
  if (/inund|agua|deslave|desliz|lluv/.test(n)) return 'inundacion';
  if (/via|carretera|calle|puente|bloque|paso/.test(n)) return 'via';
  if (/incend|fuego|quema/.test(n)) return 'incendio';
  return 'otro';
}
function mapGrupoTipo(s: string): string {
  const n = norm(s);
  if (/edificio|edif|torre|residen|conjunto/.test(n)) return 'edificio';
  if (/zona|sector|barrio|urbaniz|comunidad|parroquia|municipio/.test(n)) return 'zona';
  if (/accion|ayuda|rescate|volunt|donac/.test(n)) return 'accion';
  return 'otro';
}
// Inserta tolerando columnas que no existan en la tabla (las quita y reintenta), como el cliente.
async function insertResilient(table: string, rows: any[], conflict?: string): Promise<number> {
  if (!rows.length) return 0;
  let body = rows.map(r => ({ ...r }));
  const q = conflict ? `?on_conflict=${conflict}` : '';
  const pref = conflict ? 'resolution=merge-duplicates,return=minimal' : 'return=minimal';
  for (let i = 0; i < 6; i++) {
    const res = await fetch(`${SB}/rest/v1/${table}${q}`, { method: 'POST', headers: sbH({ Prefer: pref }), body: JSON.stringify(body) }).catch(() => null);
    if (!res) return 0;
    if (res.ok) return body.length;
    const t = await res.text();
    const m = t.match(/'([^']+)' column/i) || t.match(/column "([^"]+)"/i);   // PostgREST nombra la columna que falta
    if (m && body.some(r => m[1] in r)) { body = body.map(r => { const c = { ...r }; delete (c as any)[m[1]]; return c; }); continue; }
    return 0;
  }
  return 0;
}

type Analysis = { tipo: string; personas: any[]; centros: any[]; logistica: any[]; zonas: any[]; grupos: any[] };
// Clasifica la imagen/PDF y extrae datos estructurados (un solo llamado a Gemini).
async function analyzeFile(fileId: string, mime: string): Promise<Analysis> {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 22000);
  try {
    const f = await fetch(`https://drive.google.com/uc?export=download&id=${fileId}`, { signal: ctrl.signal });
    if (!f.ok) throw new Error('file ' + f.status);
    const b64 = toBase64(await f.arrayBuffer());
    const prompt = `Imagen/PDF de una emergencia por terremoto en Venezuela. Mírala, ENTIENDE qué información contiene y CLASIFÍCALA en el destino correcto; luego extrae los datos. Responde SOLO JSON:
{"tipo":"desaparecido|rescatado|lista_hospital|acopio|logistica|zona|grupo|otro","personas":[{"nombre":"","edad":"","zona":"","visto":"","contacto":""}],"centros":[{"nombre":"","direccion":"","telefono":""}],"logistica":[{"lugar":"","direccion":"","zona":"","necesidades":"","contacto":""}],"zonas":[{"tipo_dano":"","direccion":"","zona":"","descripcion":""}],"grupos":[{"nombre":"","tipo":"","zona":"","url":"","contacto":"","nota":""}]}
Reglas (elige UN solo tipo, el que mejor describa la imagen):
- CARTEL de persona DESAPARECIDA (dice "desaparecido/a", "ayúdanos a encontrar", "búsqueda") → tipo "desaparecido"; en personas pon nombre completo, edad (si hay), zona/estado, dónde se le vio por última vez (visto) y teléfono de contacto.
- CARTEL de persona RESCATADA/ENCONTRADA/a salvo → tipo "rescatado" (mismos campos).
- LISTA (manuscrita o impresa) de pacientes/ingresados a un hospital → tipo "lista_hospital"; personas = nombres (y edad si aparece).
- Directorio de CENTROS DE ACOPIO / puntos de ayuda → tipo "acopio"; centros = {nombre, direccion, telefono}.
- NECESIDADES/INSUMOS que HACEN FALTA en un refugio, zona o comunidad (p.ej. "se necesita/falta: agua, comida, medicinas, pañales, ropa, colchonetas") → tipo "logistica"; por cada lugar: lugar/nombre, direccion, zona/ciudad/estado, qué falta (necesidades) y contacto. Pon la ubicación más específica posible (es para un mapa).
- FOTO de DAÑOS por el terremoto (edificio colapsado, grietas, inundación/deslave, vía o puente bloqueado, incendio) → tipo "zona"; por cada daño: tipo_dano (colapso|grietas|inundacion|via|incendio|otro), direccion, zona/ciudad/estado y una descripcion breve de lo que se ve. Pon la ubicación más específica posible (es para un mapa).
- Captura/cartel de un GRUPO o canal comunitario (WhatsApp/Telegram) por zona o edificio, con enlace (wa.me, chat.whatsapp.com, t.me) o nombre de grupo → tipo "grupo"; por cada grupo: nombre, tipo (edificio|zona|accion|otro), zona/sector, url del enlace, contacto y una nota de qué se comparte.
- Cualquier otra cosa (meme, foto personal, captura sin datos útiles) → tipo "otro", todas las listas vacías.
- NUNCA incluyas cédula ni números de identidad. NO inventes: omite lo ilegible. Devuelve solo la lista del tipo elegido; las demás vacías.`;
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: b64 } }] }], generationConfig: { response_mime_type: 'application/json', temperature: 0 } }),
    });
    if (!res.ok) throw new Error('gemini ' + res.status + ' ' + (await res.text()).slice(0, 120));
    const j: any = await res.json();
    let p: any = {}; try { p = JSON.parse(j?.candidates?.[0]?.content?.parts?.[0]?.text || '{}'); } catch {}
    return { tipo: String(p.tipo || 'otro'), personas: Array.isArray(p.personas) ? p.personas : [], centros: Array.isArray(p.centros) ? p.centros : [], logistica: Array.isArray(p.logistica) ? p.logistica : [], zonas: Array.isArray(p.zonas) ? p.zonas : [], grupos: Array.isArray(p.grupos) ? p.grupos : [] };
  } finally { clearTimeout(t); }
}

async function upsert(table: string, rows: any[], conflict?: string) {
  if (!rows.length) return;
  const q = conflict ? `?on_conflict=${conflict}` : '';
  await fetch(`${SB}/rest/v1/${table}${q}`, { method: 'POST', headers: sbH({ Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify(rows) }).catch(() => {});
}
export default async function handler(req: Request): Promise<Response> {
  if (!SB || !SERVICE) return json({ error: 'no_supabase' }, 503);
  if (!GEMINI) return json({ error: 'no_gemini_key' }, 503);
  const url = (() => { try { return new URL(req.url); } catch { return null; } })();
  const keyOk = !!url && url.searchParams.get('key') === process.env.SCRAPER_WEBHOOK_SECRET;
  const only = url?.searchParams.get('file') || '';   // procesar un archivo puntual (test/targeting), requiere key
  try {
    const last = await fetch(`${SB}/rest/v1/sync_runs?source=eq.fotos&ok=eq.true&order=ran_at.desc&limit=1`, { headers: sbH() }).then(r => r.json()).catch(() => []);
    if (!keyOk && !only && Array.isArray(last) && last[0]?.ran_at && Date.now() - new Date(last[0].ran_at).getTime() < THROTTLE_MIN * 60000) {
      return json({ status: 'cached', last_sync: last[0].ran_at });
    }
    let pending: { id: string; hospital: string; tipo: string }[];
    let pendientesTotal = 0;
    if (only && keyOk) { pending = [{ id: only, hospital: 'Drive', tipo: 'imagen' }]; }
    else {
      const files = await allFiles();
      const done = new Set<string>((await fetch(`${SB}/rest/v1/foto_ocr?select=file_id`, { headers: sbH() }).then(r => r.json()).catch(() => [])).map((r: any) => r.file_id));
      const notDone = files.filter(f => !done.has(f.id));
      pendientesTotal = notDone.length;
      pending = notDone.slice(0, MAX_PER_RUN);
      if (!pending.length) { await mark(0); return json({ status: 'al_dia', total: files.length, procesadas: done.size }); }
    }

    const now = new Date().toISOString(); const report: any[] = []; let added = 0;
    for (const fl of pending) {
      const mime = fl.tipo === 'pdf' ? 'application/pdf' : 'image/jpeg';
      let a: Analysis = { tipo: 'otro', personas: [], centros: [], logistica: [], zonas: [], grupos: [] };
      try { a = await analyzeFile(fl.id, mime); } catch (e: any) { const msg = e?.message || 'err'; report.push({ id: fl.id, error: msg }); if (!/\b429\b|quota/i.test(msg)) await markDone(fl); continue; } // 429 (cuota) → NO marcar, reintenta luego
      let destino = 'otro', n = 0;
      if (a.tipo === 'desaparecido' || a.tipo === 'rescatado') {
        const estado = a.tipo === 'rescatado' ? 'encontrado' : 'buscando'; const rows: any[] = []; const seen = new Set<string>();
        for (const p of a.personas) {
          const nombre = redact(p?.nombre); if (nombre.length < 3 || !/[a-záéíóúñ]/i.test(nombre) || /\d{5,}/.test(nombre)) continue;
          const ext_id = `foto:${fl.id}:${norm(nombre)}`.slice(0, 250); if (seen.has(ext_id)) continue; seen.add(ext_id);
          rows.push({ ext_id, source: `foto:${fl.id}`, updated_at: now, nombre, edad: redact(p?.edad) || null, zona: redact(p?.zona) || null, visto: redact(p?.visto) || null, contacto: cleanPhone(p?.contacto) || null, foto_url: thumb(fl.id), estado, categoria: isMinor(p?.edad) ? 'nino' : null });
        }
        await upsert('desaparecidos_reportes', rows, 'ext_id'); destino = 'desaparecidos'; n = rows.length;
      } else if (a.tipo === 'acopio') {
        const rows: any[] = []; const seen = new Set<string>();
        for (const c of a.centros) {
          const nombre = redact(c?.nombre); if (nombre.length < 3) continue;
          const external_id = `foto:${fl.id}:${norm(nombre)}`.slice(0, 200); if (seen.has(external_id)) continue; seen.add(external_id);
          rows.push({ external_id, source: `foto:${fl.id}`, last_synced: now, nombre, direccion: redact(c?.direccion) || null, telefono: cleanPhone(c?.telefono) || null });
        }
        await upsert('centros_acopio_external', rows, 'external_id'); destino = 'acopio'; n = rows.length;
      } else if (a.tipo === 'lista_hospital') {
        const rows: any[] = []; const seen = new Set<string>();
        for (const p of a.personas) {
          const nombre = redact(p?.nombre); if (nombre.length < 3 || /\d{5,}/.test(nombre) || !/[a-záéíóúñ]/i.test(nombre)) continue;
          const ed = String(p?.edad || '').replace(/\D/g, ''); const disp = ed ? `${nombre} (${ed} años)` : nombre;
          const id = norm(`${nombre}|${fl.hospital}`).slice(0, 200); if (seen.has(id)) continue; seen.add(id);
          rows.push({ id, nombre: disp, hospital: (fl.hospital === 'Drive' || fl.hospital === 'PDF') ? null : fl.hospital, fecha: null, source: `foto:${fl.id}`, updated_at: now });
        }
        await upsert('hospital_admisiones', rows); destino = 'hospital'; n = rows.length;
      } else if (a.tipo === 'logistica') {
        const rows: any[] = []; const seen = new Set<string>(); let geocoded = 0;
        for (const L of a.logistica.slice(0, 8)) {
          const lugar = redact(L?.lugar) || '';
          const direccion = redact(L?.direccion) || '';
          const zona = redact(L?.zona) || '';
          const needs = redact(L?.necesidades) || '';
          if (!needs && !lugar) continue;
          const dedup = norm(`${lugar}|${zona}|${needs}`).slice(0, 160); if (seen.has(dedup)) continue; seen.add(dedup);
          if (geocoded >= 6) break;                                  // cota de geocodificación por archivo
          const geo = await geocodeVE([direccion, zona, lugar].filter(Boolean).join(', '));
          if (!geo) continue;                                         // sin ubicación no se puede mapear
          geocoded++;
          const contacto = cleanPhone(L?.contacto);
          rows.push({
            lat: geo.lat, lng: geo.lng, ciudad: zona || null, tipo: tipoFromNeeds(needs),
            estado: 'falta', direccion: direccion || null, descripcion: needs || null,
            nota: [lugar, needs ? 'Falta: ' + needs : '', contacto ? '📞 ' + contacto : ''].filter(Boolean).join(' · ').slice(0, 300) || null,
            foto_url: thumb(fl.id), fotos: [thumb(fl.id)],
          });
        }
        n = await insertResilient('logistica_reports', rows); destino = 'logistica';   // sin on_conflict (no hay col única); foto_ocr evita reprocesar
      } else if (a.tipo === 'zona') {
        const rows: any[] = []; const seen = new Set<string>(); let geocoded = 0;
        for (const z of a.zonas.slice(0, 8)) {
          const direccion = redact(z?.direccion) || '';
          const zona = redact(z?.zona) || '';
          const descripcion = redact(z?.descripcion) || '';
          const dedup = norm(`${direccion}|${zona}|${descripcion}`).slice(0, 160); if (seen.has(dedup)) continue; seen.add(dedup);
          if (geocoded >= 6) break;
          const geo = await geocodeVE([direccion, zona].filter(Boolean).join(', '));
          if (!geo) continue;                                          // sin ubicación no se puede mapear
          geocoded++;
          rows.push({ lat: geo.lat, lng: geo.lng, ciudad: zona || null, tipo: mapZonaTipo(`${z?.tipo_dano} ${descripcion}`), direccion: direccion || null, descripcion: descripcion || null, foto_url: thumb(fl.id), fotos: [thumb(fl.id)] });
        }
        n = await insertResilient('zona_reports', rows); destino = 'zona';
      } else if (a.tipo === 'grupo') {
        const rows: any[] = []; const seen = new Set<string>();
        for (const g of a.grupos.slice(0, 12)) {
          const nombre = redact(g?.nombre) || '';
          let url = String(g?.url || '').trim().slice(0, 300);
          if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
          const urlOk = /wa\.me|chat\.whatsapp\.com|whatsapp\.com|t\.me|telegram/i.test(url);
          if (nombre.length < 2 && !urlOk) continue;                   // ni nombre ni enlace → inservible
          const dedup = norm(`${nombre}|${url}`).slice(0, 160); if (seen.has(dedup)) continue; seen.add(dedup);
          rows.push({ nombre: nombre || 'Grupo comunitario', tipo: mapGrupoTipo(`${g?.tipo} ${nombre}`), zona: redact(g?.zona) || null, url: urlOk ? url : null, contacto: cleanPhone(g?.contacto) || null, nota: (redact(g?.nota) || null) });
        }
        n = await insertResilient('grupos_comunitarios', rows); destino = 'grupo';
      }
      await markDone(fl, n);
      added += n; report.push({ id: fl.id, tipo: a.tipo, destino, agregados: n });
    }
    await mark(added);
    return json({ status: 'procesado', archivos: report, total_agregados: added, restantes: Math.max(0, pendientesTotal - pending.length) });
  } catch (e: any) {
    return json({ error: 'sync_failed', detail: e?.message }, 500);
  }
}
async function markDone(fl: { id: string; hospital: string }, names = 0) {
  await fetch(`${SB}/rest/v1/foto_ocr`, { method: 'POST', headers: sbH({ Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify([{ file_id: fl.id, hospital: fl.hospital, names }]) }).catch(() => {});
}
async function mark(count: number) {
  await fetch(`${SB}/rest/v1/sync_runs`, { method: 'POST', headers: sbH({ Prefer: 'return=minimal' }), body: JSON.stringify([{ source: 'fotos', ok: true, count }]) }).catch(() => {});
}
function json(b: unknown, s = 200): Response {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
}
