/**
 * SismoVE · Sync de personas desaparecidas: Google Drive (CSV / Sheet) → Supabase
 *
 * Detecta en la carpeta pública (raíz + subcarpetas, 1 nivel) cualquier Google Sheet o
 * archivo .csv cuyo NOMBRE contenga "desaparec" / "menores" / "niños" / "extravi", lo
 * descarga como CSV, mapea las columnas (encabezados flexibles en español), y hace UPSERT
 * en `desaparecidos_reportes` con una clave estable (ext_id) → re-sincroniza sin duplicar.
 *
 * NO toca los reportes hechos desde la app (esos tienen ext_id NULL). NUNCA guarda cédulas
 * ni documentos de identidad (esas columnas se ignoran). NUNCA borra. Throttle 15 min.
 *
 * Para que la gente solo deba "dejar el archivo en el Drive":
 *   - Google Sheet  → la lee vía export?format=csv (primera hoja).
 *   - .csv subido    → la lee vía uc?export=download (archivo público).
 * Requiere env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Force con ?key=SCRAPER_WEBHOOK_SECRET.
 */
export const config = { runtime: 'edge' };

const SB = process.env.SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const FOLDER = process.env.DRIVE_FOLDER_ID || '1o36ifaRz45kAs5rKzci49aD0mP5JB_YI';
const THROTTLE_MIN = 15;
const NAME_RE = /desaparec|extravi|menores|ni[nñ]os|ni[nñ]as/i;
const ENTRY_RE = /<div class="flip-entry"[^>]*id="entry-([^"]+)"[\s\S]*?<a href="([^"]+)"[\s\S]*?<div class="flip-entry-title">([^<]*)<\/div>/g;

function sbH(extra: Record<string, string> = {}) {
  return { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...extra };
}

// ── Drive: listar carpeta (sin API key) ───────────────────────────────────────
async function listFolder(id: string) {
  const html = await (await fetch(`https://drive.google.com/embeddedfolderview?id=${id}#list`, { headers: { 'User-Agent': 'Mozilla/5.0 (SismoVE)' } })).text();
  const out: { id: string; name: string; url: string }[] = []; let m: RegExpExecArray | null; ENTRY_RE.lastIndex = 0;
  while ((m = ENTRY_RE.exec(html)) !== null) { const name = m[3].trim(); if (name) out.push({ id: m[1], name, url: m[2] }); }
  return out;
}
// Candidatos = Sheets o .csv con nombre que matchee NAME_RE (raíz + subcarpetas 1 nivel)
async function findFiles(): Promise<{ id: string; name: string; kind: 'sheet' | 'csv' }[]> {
  const pick = (e: { id: string; name: string; url: string }): { id: string; name: string; kind: 'sheet' | 'csv' } | null => {
    if (!NAME_RE.test(e.name)) return null;
    if (e.url.includes('/spreadsheets/')) return { id: e.id, name: e.name, kind: 'sheet' };
    if (/\.csv$/i.test(e.name)) return { id: e.id, name: e.name, kind: 'csv' };
    return null;
  };
  const found: { id: string; name: string; kind: 'sheet' | 'csv' }[] = [];
  const root = await listFolder(FOLDER);
  for (const e of root) { const p = pick(e); if (p) found.push(p); }
  for (const f of root.filter(e => e.url.includes('/drive/folders/'))) {
    try { for (const c of await listFolder(f.id)) { const p = pick(c); if (p) found.push(p); } } catch {}
  }
  const seen = new Set<string>();
  return found.filter(f => seen.has(f.id) ? false : (seen.add(f.id), true));
}
async function downloadCsv(f: { id: string; kind: 'sheet' | 'csv' }): Promise<string> {
  const url = f.kind === 'sheet'
    ? `https://docs.google.com/spreadsheets/d/${f.id}/export?format=csv`
    : `https://drive.google.com/uc?export=download&id=${f.id}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (SismoVE)' } });
  if (!r.ok) throw new Error('download ' + r.status);
  const txt = await r.text();
  if (/^\s*<!DOCTYPE|^\s*<html/i.test(txt)) throw new Error('drive_html'); // interstitial / no público
  return txt;
}

// ── CSV: parser tolerante (comillas, comas y saltos de línea dentro de celdas) ─
function parseCSV(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cur = ''; let q = false;
  const s = text.replace(/^﻿/, '');           // quita BOM
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (ch === '\r') { /* ignora; \n cierra la fila */ }
    else cur += ch;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim()));   // descarta filas totalmente vacías
}
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

// Sinónimos de encabezado → nuestra columna. Cédula/documento NO está → se ignora siempre.
// OJO: en Venezuela "Estado" = provincia (Yaracuy, Lara…) → va a `zona`. El estatus
// buscando/encontrado se nombra "Situación" o "Estatus" para no chocar con la provincia.
const FIELD_SYNS: Record<string, RegExp> = {
  nombre:   /nombre|^(persona|menor|nin[oa]s?|desaparecid[oa])$/,
  edad:     /^(edad|anos|a[nñ]os|edad \(anos\))$/,
  zona:     /^(zona|ciudad|estado|municipio|localidad|sector|parroquia|entidad)$/,
  visto:    /ultima vez|visto|donde|ubicacion|^lugar|desaparici|desaparecio|^punto/,
  contacto: /^(contacto|telefono|celular|tlf|whatsapp|movil|numero|contacto de quien busca)$/,
  nota:     /^(nota|notas|observacion(es)?|detalle(s)?|descripcion|se[nñ]as|ropa|caracteristicas)$/,
  foto_url: /^(foto|foto_url|foto url|imagen|url foto|enlace foto|photo|link foto)$/,
  estado:   /^(situacion|estatus|status|condicion|encontrado)$/,
};
// Cada columna se asigna a UN SOLO campo (el primero que matchee, por orden) → un encabezado
// nunca alimenta dos campos a la vez.
function mapHeaders(header: string[]): Record<string, number> {
  const idx: Record<string, number> = {};
  header.forEach((h, i) => {
    const n = norm(h);
    for (const [field, re] of Object.entries(FIELD_SYNS)) {
      if (idx[field] === undefined && re.test(n)) { idx[field] = i; break; }
    }
  });
  return idx;
}
// Convierte un enlace de Drive a una URL que <img> puede mostrar (thumbnail, sin interstitial)
function fixDriveImg(u: string): string {
  const m = u.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?[^]*?id=)([\w-]{20,})/);
  return m ? `https://drive.google.com/thumbnail?id=${m[1]}&sz=w1000` : u;
}

export default async function handler(req: Request): Promise<Response> {
  if (!SB || !SERVICE) return json({ error: 'no_supabase' }, 503);
  const force = (() => { try { const k = new URL(req.url).searchParams.get('key'); return !!k && k === process.env.SCRAPER_WEBHOOK_SECRET; } catch { return false; } })();
  try {
    const last = await fetch(`${SB}/rest/v1/sync_runs?source=eq.desaparecidos&ok=eq.true&order=ran_at.desc&limit=1`, { headers: sbH() }).then(r => r.json()).catch(() => []);
    if (!force && Array.isArray(last) && last[0]?.ran_at && Date.now() - new Date(last[0].ran_at).getTime() < THROTTLE_MIN * 60000) {
      return json({ status: 'cached', last_sync: last[0].ran_at });
    }

    const files = await findFiles();
    if (!files.length) { await mark(0); return json({ status: 'sin_archivo', hint: 'Sube una Google Sheet o un .csv con "desaparecidos" en el nombre a la carpeta del Drive.' }); }

    const rows: any[] = []; const seen = new Set<string>(); const archivos: any[] = [];
    for (const f of files) {
      try {
        const grid = parseCSV(await downloadCsv(f));
        if (grid.length < 2) { archivos.push({ name: f.name, filas: 0 }); continue; }
        const idx = mapHeaders(grid[0]);
        if (idx.nombre === undefined) { archivos.push({ name: f.name, error: 'falta_columna_nombre' }); continue; }
        let n = 0;
        for (let r = 1; r < grid.length; r++) {
          const cell = (k: string) => { const i = idx[k]; return i === undefined ? '' : (grid[r][i] || '').trim(); };
          const nombre = cell('nombre'); if (nombre.length < 2) continue;
          const zona = cell('zona'), visto = cell('visto');
          const ext_id = `drive:${norm([nombre, zona, visto, cell('edad')].join('|'))}`.slice(0, 250);
          if (seen.has(ext_id)) continue; seen.add(ext_id);
          const estado = /encontrad/i.test(cell('estado')) ? 'encontrado' : 'buscando';
          let foto = cell('foto_url'); if (foto && /drive\.google\.com/.test(foto)) foto = fixDriveImg(foto);
          rows.push({
            ext_id, source: 'drive', nombre,
            edad: cell('edad') || null, zona: zona || null, visto: visto || null,
            contacto: cell('contacto') || null, nota: cell('nota') || null,
            foto_url: foto || null, estado,
          });
          n++;
        }
        archivos.push({ name: f.name, filas: n });
      } catch (e: any) { archivos.push({ name: f.name, error: e?.message || 'parse' }); }
    }

    if (rows.length) {
      for (let i = 0; i < rows.length; i += 500) {
        const r = await fetch(`${SB}/rest/v1/desaparecidos_reportes?on_conflict=ext_id`, {
          method: 'POST', headers: sbH({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
          body: JSON.stringify(rows.slice(i, i + 500)),
        });
        if (!r.ok) throw new Error(`upsert ${r.status}: ${(await r.text()).slice(0, 140)}`);
      }
    }
    await mark(rows.length);
    return json({ status: 'synced', personas: rows.length, archivos });
  } catch (e: any) {
    return json({ error: 'sync_failed', detail: e?.message }, 500);
  }
}
async function mark(count: number) {
  await fetch(`${SB}/rest/v1/sync_runs`, { method: 'POST', headers: sbH({ Prefer: 'return=minimal' }), body: JSON.stringify([{ source: 'desaparecidos', ok: true, count }]) }).catch(() => {});
}
function json(b: unknown, s = 200): Response {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
}
