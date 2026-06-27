/**
 * SismoVE · Auto-OCR + CLASIFICACIÓN de imágenes/PDFs del Drive → Supabase (Gemini Vision)
 *
 * Recorre todas las carpetas (+ subcarpetas) recursivamente, detecta imágenes/PDFs aún NO
 * procesados (tabla foto_ocr), y por cada uno Gemini CLASIFICA y EXTRAE → rutea a su tabla:
 *   cartel desaparecido/rescatado → desaparecidos_reportes (foto del cartel; rescatado=encontrado;
 *                                   menores → categoria 'nino')
 *   lista de pacientes de hospital → hospital_admisiones
 *   directorio de acopio           → centros_acopio_external
 *   otro                            → se ignora
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

type Analysis = { tipo: string; personas: any[]; centros: any[] };
// Clasifica la imagen/PDF y extrae datos estructurados (un solo llamado a Gemini).
async function analyzeFile(fileId: string, mime: string): Promise<Analysis> {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 22000);
  try {
    const f = await fetch(`https://drive.google.com/uc?export=download&id=${fileId}`, { signal: ctrl.signal });
    if (!f.ok) throw new Error('file ' + f.status);
    const b64 = toBase64(await f.arrayBuffer());
    const prompt = `Imagen/PDF de una emergencia por terremoto en Venezuela. CLASIFÍCALA y extrae datos. Responde SOLO JSON:
{"tipo":"desaparecido|rescatado|lista_hospital|acopio|otro","personas":[{"nombre":"","edad":"","zona":"","visto":"","contacto":""}],"centros":[{"nombre":"","direccion":"","telefono":""}]}
Reglas:
- CARTEL de persona DESAPARECIDA (dice "desaparecido/a", "ayúdanos a encontrar", "búsqueda") → tipo "desaparecido"; en personas pon nombre completo, edad (si hay), zona/estado, dónde se le vio por última vez (visto) y teléfono de contacto.
- CARTEL de persona RESCATADA/ENCONTRADA/a salvo → tipo "rescatado" (mismos campos).
- LISTA (manuscrita o impresa) de pacientes/ingresados a un hospital → tipo "lista_hospital"; personas = nombres (y edad si aparece).
- Directorio de CENTROS DE ACOPIO / puntos de ayuda → tipo "acopio"; centros = {nombre, direccion, telefono}.
- Cualquier otra cosa (captura de pantalla, meme, foto sin datos) → tipo "otro", listas vacías.
- NUNCA incluyas cédula ni números de identidad. NO inventes: omite lo ilegible.`;
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: b64 } }] }], generationConfig: { response_mime_type: 'application/json', temperature: 0 } }),
    });
    if (!res.ok) throw new Error('gemini ' + res.status + ' ' + (await res.text()).slice(0, 120));
    const j: any = await res.json();
    let p: any = {}; try { p = JSON.parse(j?.candidates?.[0]?.content?.parts?.[0]?.text || '{}'); } catch {}
    return { tipo: String(p.tipo || 'otro'), personas: Array.isArray(p.personas) ? p.personas : [], centros: Array.isArray(p.centros) ? p.centros : [] };
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
      let a: Analysis = { tipo: 'otro', personas: [], centros: [] };
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
