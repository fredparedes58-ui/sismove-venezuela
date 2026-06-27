/**
 * SismoVE · Auto-OCR de archivos NUEVOS del Drive → Supabase (Gemini Vision)
 *
 * Recorre la carpeta (+ subcarpetas), detecta IMÁGENES y PDFs aún NO procesados
 * (tabla foto_ocr), los pasa por Gemini para extraer nombres (omite cédulas) y hace
 * upsert en hospital_admisiones. Marca cada archivo en foto_ocr para no repetir.
 * Pocos por llamada (tiempo/cuota). Throttle 10 min.
 *
 * Requiere env: GEMINI_API_KEY (free). Modelo: GEMINI_MODEL (def gemini-2.5-flash).
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
async function ocrFile(fileId: string, mime: string): Promise<{ nombre: string; edad?: string }[]> {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20000); // tope para no exceder el Edge
  try {
    const f = await fetch(`https://drive.google.com/uc?export=download&id=${fileId}`, { signal: ctrl.signal });
    if (!f.ok) throw new Error('file ' + f.status);
    const b64 = toBase64(await f.arrayBuffer());
    const prompt = 'Esto es una imagen o PDF de un listado (manuscrito o impreso) de personas ingresadas/atendidas en un hospital tras un terremoto. Extrae SOLO los nombres legibles de personas (apellidos y nombres) y la edad si aparece. NO incluyas cédulas ni números de identificación. NO inventes: omite lo ilegible. Si NO es un listado de personas, devuelve entries vacío. Responde SOLO JSON: {"entries":[{"nombre":"","edad":""}]}.';
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: b64 } }] }], generationConfig: { response_mime_type: 'application/json', temperature: 0 } }),
    });
    if (!res.ok) throw new Error('gemini ' + res.status + ' ' + (await res.text()).slice(0, 120));
    const j: any = await res.json();
    let parsed: any = {}; try { parsed = JSON.parse(j?.candidates?.[0]?.content?.parts?.[0]?.text || '{}'); } catch {}
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } finally { clearTimeout(t); }
}

export default async function handler(req: Request): Promise<Response> {
  if (!SB || !SERVICE) return json({ error: 'no_supabase' }, 503);
  if (!GEMINI) return json({ error: 'no_gemini_key' }, 503);
  const force = (() => { try { const k = new URL(req.url).searchParams.get('key'); return !!k && k === process.env.SCRAPER_WEBHOOK_SECRET; } catch { return false; } })();
  try {
    const last = await fetch(`${SB}/rest/v1/sync_runs?source=eq.fotos&ok=eq.true&order=ran_at.desc&limit=1`, { headers: sbH() }).then(r => r.json()).catch(() => []);
    if (!force && Array.isArray(last) && last[0]?.ran_at && Date.now() - new Date(last[0].ran_at).getTime() < THROTTLE_MIN * 60000) {
      return json({ status: 'cached', last_sync: last[0].ran_at });
    }
    const files = await allFiles();
    const done = new Set<string>((await fetch(`${SB}/rest/v1/foto_ocr?select=file_id`, { headers: sbH() }).then(r => r.json()).catch(() => [])).map((r: any) => r.file_id));
    const pending = files.filter(f => !done.has(f.id)).slice(0, MAX_PER_RUN);
    if (!pending.length) { await mark(0); return json({ status: 'al_dia', total: files.length, procesadas: done.size }); }

    let added = 0; const now = new Date().toISOString();
    for (const fl of pending) {
      const isPdf = fl.tipo === 'pdf';
      let entries: any[] = [];
      try { entries = await ocrFile(fl.id, isPdf ? 'application/pdf' : 'image/jpeg'); } catch (e: any) { console.error('ocr', fl.id, e?.message); }
      const rows: any[] = []; const seen = new Set<string>();
      for (const e of entries) {
        let nombre = String(e?.nombre || '').replace(/\s+/g, ' ').trim();
        if (nombre.length < 3 || /\d{5,}/.test(nombre)) continue;
        const ed = ('' + (e?.edad || '')).replace(/\D/g, '');
        const disp = ed ? `${nombre} (${ed} años)` : nombre;
        const tag = isPdf ? 'pdf' : 'foto';
        const id = `${tag}:${nombre}|${fl.hospital}`.toLowerCase().replace(/\s+/g, ' ').slice(0, 200);
        if (seen.has(id)) continue; seen.add(id);
        rows.push({ id, nombre: disp, hospital: fl.hospital === 'PDF' || fl.hospital === 'Drive' ? null : fl.hospital, fecha: null, source: `${tag} · ${fl.hospital}`, updated_at: now });
      }
      if (rows.length) await fetch(`${SB}/rest/v1/hospital_admisiones`, { method: 'POST', headers: sbH({ Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify(rows) }).catch(() => {});
      await fetch(`${SB}/rest/v1/foto_ocr`, { method: 'POST', headers: sbH({ Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify([{ file_id: fl.id, hospital: fl.hospital, names: rows.length }]) }).catch(() => {});
      added += rows.length;
    }
    await mark(added);
    const remaining = files.filter(f => !done.has(f.id)).length - pending.length;
    return json({ status: 'procesado', archivos: pending.length, nombres_agregados: added, restantes: Math.max(0, remaining) });
  } catch (e: any) {
    return json({ error: 'sync_failed', detail: e?.message }, 500);
  }
}
async function mark(count: number) {
  await fetch(`${SB}/rest/v1/sync_runs`, { method: 'POST', headers: sbH({ Prefer: 'return=minimal' }), body: JSON.stringify([{ source: 'fotos', ok: true, count }]) }).catch(() => {});
}
function json(b: unknown, s = 200): Response {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
}
