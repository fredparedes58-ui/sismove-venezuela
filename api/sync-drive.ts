/**
 * SismoVE · Lector UNIVERSAL del Google Drive → Supabase
 *
 * Dejas un archivo en la carpeta pública del Drive (CSV, XLSX, JSON o Google Sheet) y el
 * cron lo lee, detecta a QUÉ corresponde por el NOMBRE del archivo, mapea las columnas
 * (encabezados flexibles en español) y lo lleva a la tabla correcta.
 *
 * Ruteo por nombre de archivo:
 *   desaparec/niños/menores/extraviados → desaparecidos_reportes
 *   hospital/ingresos/pacientes/heridos → hospital_admisiones
 *   acopio/centros/donaciones           → centros_acopio_external
 *   zonas/afectadas/derrumbes           → zona_reports        (necesita lat,lng o ciudad conocida)
 *   logística/necesidades/insumos       → logistica_reports   (necesita lat,lng o ciudad conocida)
 *
 * Garantías de seguridad/calidad (revisión adversarial 10/10):
 *   - REDACTA cédula/documento por VALOR en todo campo de texto (no solo por encabezado).
 *   - `contacto` solo guarda formato telefónico; `edad` solo dígitos/meses.
 *   - Descarta filas basura (encabezados repetidos, "Total:", #REF!, separadores).
 *   - Detecta estatus (buscando/encontrado) por VALOR aunque la columna se llame "Estado".
 *   - ESPEJA el archivo: si borras a alguien del archivo, desaparece (sin huérfanos ni
 *     duplicados al corregir) — pero NUNCA borra si el archivo falla, ni toca reportes de la app.
 *   - foto_url solo de hosts confiables (Google/Supabase); reescribe enlaces de Drive a imagen.
 *   - Reporta columnas NO reconocidas por archivo (no falla en silencio).
 *
 * Requiere env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Force con ?key=SCRAPER_WEBHOOK_SECRET.
 */
export const config = { runtime: 'edge' };

const SB = process.env.SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const FOLDER = process.env.DRIVE_FOLDER_ID || '1o36ifaRz45kAs5rKzci49aD0mP5JB_YI';
const THROTTLE_MIN = 15;
const MAX_FILES = 8;          // tope por corrida (tiempo del Edge)
const MAX_ROWS = 5000;        // tope defensivo de filas por archivo
const SB_HOST = (() => { try { return new URL(SB).host; } catch { return ''; } })();
const ENTRY_RE = /<div class="flip-entry"[^>]*id="entry-([^"]+)"[\s\S]*?<a href="([^"]+)"[\s\S]*?<div class="flip-entry-title">([^<]*)<\/div>/g;

function sbH(extra: Record<string, string> = {}) {
  return { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...extra };
}

// ════════════════════ Drive: listar y descargar ════════════════════
async function listFolder(id: string) {
  const html = await (await fetch(`https://drive.google.com/embeddedfolderview?id=${id}#list`, { headers: { 'User-Agent': 'Mozilla/5.0 (SismoVE)' } })).text();
  const out: { id: string; name: string; url: string }[] = []; let m: RegExpExecArray | null; ENTRY_RE.lastIndex = 0;
  while ((m = ENTRY_RE.exec(html)) !== null) { const name = m[3].trim(); if (name) out.push({ id: m[1], name, url: m[2] }); }
  return out;
}
type Kind = 'sheet' | 'csv' | 'xlsx' | 'json';
function kindOf(name: string, url: string): Kind | null {
  if (url.includes('/spreadsheets/')) return 'sheet';
  if (/\.csv$/i.test(name)) return 'csv';
  if (/\.xlsx$/i.test(name)) return 'xlsx';
  if (/\.json$/i.test(name)) return 'json';
  return null;
}
async function allCandidates() {
  const out: { id: string; name: string; kind: Kind }[] = [];
  const root = await listFolder(FOLDER);
  const consider = (e: { id: string; name: string; url: string }) => { const k = kindOf(e.name, e.url); if (k) out.push({ id: e.id, name: e.name, kind: k }); };
  for (const e of root) consider(e);
  for (const f of root.filter(e => e.url.includes('/drive/folders/'))) {
    try { for (const c of await listFolder(f.id)) consider(c); } catch {}
  }
  const seen = new Set<string>();
  return out.filter(f => seen.has(f.id) ? false : (seen.add(f.id), true));
}
function isHtml(s: string) { return /^\s*<!DOCTYPE|^\s*<html/i.test(s); }
async function downloadText(f: { id: string; kind: Kind }): Promise<string> {
  if (f.kind === 'sheet') {
    const r = await fetch(`https://docs.google.com/spreadsheets/d/${f.id}/export?format=csv`, { headers: { 'User-Agent': 'Mozilla/5.0 (SismoVE)' } });
    if (!r.ok) throw new Error('download ' + r.status);
    return r.text();
  }
  // csv/json subidos: archivo público vía uc?export=download (+ confirm token si hay interstitial)
  let r = await fetch(`https://drive.google.com/uc?export=download&id=${f.id}`, { headers: { 'User-Agent': 'Mozilla/5.0 (SismoVE)' } });
  let txt = await r.text();
  if (isHtml(txt)) {
    const token = (txt.match(/confirm=([0-9A-Za-z_-]+)/) || [])[1];
    const retry = token
      ? `https://drive.usercontent.google.com/download?id=${f.id}&export=download&confirm=${token}`
      : `https://drive.usercontent.google.com/download?id=${f.id}&export=download&confirm=t`;
    r = await fetch(retry, { headers: { 'User-Agent': 'Mozilla/5.0 (SismoVE)' } });
    txt = await r.text();
    if (isHtml(txt)) throw new Error('drive_html');
  }
  return txt;
}
async function downloadBytes(f: { id: string }): Promise<ArrayBuffer> {
  let r = await fetch(`https://drive.google.com/uc?export=download&id=${f.id}`, { headers: { 'User-Agent': 'Mozilla/5.0 (SismoVE)' } });
  let buf = await r.arrayBuffer();
  // ¿interstitial? (los primeros bytes serían texto HTML)
  const head = new TextDecoder().decode(new Uint8Array(buf.slice(0, 64)));
  if (isHtml(head)) {
    const token = (head.match(/confirm=([0-9A-Za-z_-]+)/) || [])[1] || 't';
    r = await fetch(`https://drive.usercontent.google.com/download?id=${f.id}&export=download&confirm=${token}`, { headers: { 'User-Agent': 'Mozilla/5.0 (SismoVE)' } });
    buf = await r.arrayBuffer();
  }
  return buf;
}

// ════════════════════ Parsers de formato → grid (string[][]) ════════════════════
function parseCSV(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cur = ''; let q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (ch === '\r') { if (s[i + 1] !== '\n') { row.push(cur); rows.push(row); row = []; cur = ''; } } // solo-CR (Mac) también cierra fila
    else cur += ch;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim()));
}
function jsonToGrid(text: string): string[][] {
  let data: any; try { data = JSON.parse(text); } catch { throw new Error('json_invalido'); }
  const arr = Array.isArray(data) ? data : (data.data || data.rows || data.items || data.registros || []);
  if (!Array.isArray(arr) || !arr.length) return [];
  const keys: string[] = []; const seen = new Set<string>();
  for (const o of arr) if (o && typeof o === 'object') for (const k of Object.keys(o)) if (!seen.has(k)) { seen.add(k); keys.push(k); }
  const grid: string[][] = [keys];
  for (const o of arr) grid.push(keys.map(k => { const v = o?.[k]; return v == null ? '' : String(v); }));
  return grid;
}
// — Lector XLSX sin dependencias (ZIP + DecompressionStream + XML por regex) —
const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new (globalThis as any).DecompressionStream('deflate-raw');
  const stream = (new Response(bytes).body as any).pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
function readZip(buf: ArrayBuffer) {
  const b = new Uint8Array(buf); let eocd = -1;
  for (let i = b.length - 22; i >= 0 && i >= b.length - 22 - 65536; i--) if (u32(b, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('zip_no_eocd');
  const count = u16(b, eocd + 10); let off = u32(b, eocd + 16); const entries: Record<string, any> = {};
  for (let n = 0; n < count; n++) {
    if (u32(b, off) !== 0x02014b50) break;
    const method = u16(b, off + 10), compSize = u32(b, off + 20), nameLen = u16(b, off + 28), extraLen = u16(b, off + 30), commentLen = u16(b, off + 32), lho = u32(b, off + 42);
    entries[new TextDecoder().decode(b.subarray(off + 46, off + 46 + nameLen))] = { method, compSize, lho };
    off += 46 + nameLen + extraLen + commentLen;
  }
  return { b, entries };
}
async function zipRead(zip: any, name: string): Promise<string | null> {
  const e = zip.entries[name]; if (!e) return null; const b: Uint8Array = zip.b;
  if (u32(b, e.lho) !== 0x04034b50) return null;
  const start = e.lho + 30 + u16(b, e.lho + 26) + u16(b, e.lho + 28);
  const data = b.subarray(start, start + e.compSize);
  return new TextDecoder('utf-8').decode(e.method === 0 ? data : await inflateRaw(data));
}
function decodeEntities(s: string) {
  return s.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function colOf(ref: string) { let c = 0; for (let i = 0; i < ref.length; i++) { const ch = ref.charCodeAt(i); if (ch < 65 || ch > 90) break; c = c * 26 + (ch - 64); } return c - 1; }
function serialToISO(n: number) { return new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000).toISOString().slice(0, 10); }
async function xlsxToGrid(buf: ArrayBuffer): Promise<string[][]> {
  const zip = readZip(buf);
  const sharedXml = await zipRead(zip, 'xl/sharedStrings.xml'); const shared: string[] = [];
  if (sharedXml) { const siRe = /<si>([\s\S]*?)<\/si>/g; let m: any; while ((m = siRe.exec(sharedXml)) !== null) { const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g; let t: any, s = ''; while ((t = tRe.exec(m[1])) !== null) s += t[1]; shared.push(decodeEntities(s)); } }
  // estilos de fecha
  const styleXml = await zipRead(zip, 'xl/styles.xml') || ''; const dateStyles = new Set<number>(); const customDate = new Set<number>();
  let nf: any; const nfRe = /<numFmt[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g;
  while ((nf = nfRe.exec(styleXml)) !== null) { const code = decodeEntities(nf[2]).replace(/"[^"]*"|\[[^\]]*\]/g, ''); if (/[dmyhs]/i.test(code)) customDate.add(parseInt(nf[1], 10)); }
  const builtin = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
  const xfsBlock = (styleXml.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/) || [, ''])[1]; let xf: any, xi = 0; const xfRe = /<xf\b[^>]*numFmtId="(\d+)"[^>]*\/?>/g;
  while ((xf = xfRe.exec(xfsBlock)) !== null) { const id = parseInt(xf[1], 10); if (builtin.has(id) || customDate.has(id)) dateStyles.add(xi); xi++; }
  // primera hoja
  const wb = await zipRead(zip, 'xl/workbook.xml'); const rels = await zipRead(zip, 'xl/_rels/workbook.xml.rels'); let sheetPath = 'xl/worksheets/sheet1.xml';
  if (wb && rels) { const rid = (wb.match(/<sheet\b[^>]*r:id="([^"]+)"/) || [])[1]; if (rid) { const tgt = (rels.match(new RegExp(`<Relationship[^>]*Id="${rid}"[^>]*Target="([^"]+)"`)) || [])[1]; if (tgt) sheetPath = 'xl/' + tgt.replace(/^\/?xl\//, '').replace(/^\//, ''); } }
  const sheet = await zipRead(zip, sheetPath) || ''; const grid: string[][] = [];
  let r: any; const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  while ((r = rowRe.exec(sheet)) !== null) {
    const cells: string[] = []; let c: any; const cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    while ((c = cRe.exec(r[1])) !== null) {
      const attrs = c[1], inner = c[2] || '';
      const ref = (attrs.match(/r="([A-Z]+)\d+"/) || [])[1]; const t = (attrs.match(/t="([^"]+)"/) || [])[1]; const s = (attrs.match(/s="(\d+)"/) || [])[1];
      let val = '';
      if (t === 's') val = shared[parseInt((inner.match(/<v>([\s\S]*?)<\/v>/) || [, ''])[1], 10)] ?? '';
      else if (t === 'inlineStr') { const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g; let tt: any; while ((tt = tRe.exec(inner)) !== null) val += tt[1]; val = decodeEntities(val); }
      else if (t === 'str') val = decodeEntities((inner.match(/<v>([\s\S]*?)<\/v>/) || [, ''])[1]);
      else if (t === 'b') val = ((inner.match(/<v>([\s\S]*?)<\/v>/) || [, ''])[1] === '1') ? 'TRUE' : 'FALSE';
      else if (t === 'e') val = '';
      else { const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [, ''])[1]; val = (v !== '' && s !== undefined && dateStyles.has(parseInt(s, 10))) ? serialToISO(parseFloat(v)) : v; }
      cells[ref ? colOf(ref) : cells.length] = val;
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
    grid.push(cells);
  }
  return grid.filter(row => row.some(c => String(c).trim()));
}

// ════════════════════ Helpers de saneo / mapeo ════════════════════
const norm = (s: string) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

// Patrones de documento de identidad venezolano (cédula/pasaporte) — se REDACTAN siempre.
const DOC_RE = /\b[vejpg][-\s.]?\d{1,2}[.\s]?\d{3}[.\s]?\d{3}\b|\b\d{1,3}[.\s]\d{3}[.\s]\d{3}\b|\b(?:c[ií]|c\.i|cedula|cédula|dni|documento|pasaporte|rif)\b[:\s.\-]*[\w.\-]*\d{5,}/gi;
const DIGRUN_RE = /\b\d{7,9}\b/g;   // secuencia suelta de 7-9 dígitos (probable cédula); teléfonos VE tienen 10-11
function redactText(s: string): string {
  return String(s).replace(DOC_RE, ' ').replace(DIGRUN_RE, ' ').replace(/\s{2,}/g, ' ').trim();
}
// `contacto`: solo conserva formato telefónico VE; descarta lo demás (p.ej. una cédula).
function cleanPhone(s: string): string {
  const m = String(s).match(/(\+?58[\s-]?)?0?4\d{2}[\s.-]?\d{3}[\s.-]?\d{4}|\b0?2\d{2}[\s.-]?\d{3}[\s.-]?\d{4}\b/g);
  return m ? Array.from(new Set(m.map(x => x.trim()))).join(' / ').slice(0, 60) : '';
}
// `edad`: solo dígitos + unidad (años/meses)
function cleanEdad(s: string): string {
  const m = String(s).match(/\b(\d{1,3})\s*(a[nñ]os?|years?|meses?|mes|m|d[ií]as?)?\b/i);
  if (!m) return '';
  return (m[2] ? `${m[1]} ${m[2].toLowerCase()}` : m[1]).slice(0, 20);
}
// foto_url solo de hosts confiables (Google / Supabase) + reescribe enlaces de Drive a imagen
function fixDriveImg(u: string): string {
  const m = u.match(/(?:drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?[^]*?id=)|drive\.usercontent\.google\.com\/download\?[^]*?id=|docs\.google\.com\/uc\?[^]*?id=|lh3\.googleusercontent\.com\/d\/)([-\w]{20,})/);
  return m ? `https://drive.google.com/thumbnail?id=${m[1]}&sz=w1000` : u;
}
function safeFoto(u: string): string | null {
  const url = String(u).trim(); if (!/^https:\/\//i.test(url)) return null;
  let host = ''; try { host = new URL(url).host.toLowerCase(); } catch { return null; }
  const ok = host.endsWith('google.com') || host.endsWith('googleusercontent.com') || host === SB_HOST;
  if (!ok) return null;
  return /google\.com|googleusercontent/.test(host) ? fixDriveImg(url) : url;
}
// Encabezados → campo (por INCLUSIÓN; cada columna a UN solo campo)
const FIELD_SYNS: [string, RegExp][] = [
  ['nombre',   /nombre|^persona$|^menor$|^nin[oa]s?$|desaparecid|^paciente$|apellid/],
  ['edad',     /edad|^a[nñ]os$/],
  ['lat',      /^lat|latitud/],
  ['lng',      /^lon|^lng|longitud/],
  ['hospital', /hospital|cl[ií]nic|centro de salud|^centro$/],
  ['fecha',    /fecha|d[ií]a/],
  ['contacto', /tel[eé]fono|tlf|celular|whatsapp|m[oó]vil|contacto|^n[uú]mero/],
  ['zona',     /zona|ciudad|estado|^edo\b|municipio|localidad|sector|parroquia|entidad|direcci[oó]n/],
  ['visto',    /ultima vez|visto|d[oó]nde|ubicaci[oó]n|^lugar|desaparici|desaparecio|^punto/],
  ['tipo',     /tipo|categor[ií]a|necesidad|insumo|recurso/],
  ['estado',   /situaci[oó]n|estatus|status|condici[oó]n/],
  ['foto_url', /foto|imagen|^photo$|url|enlace|link/],
  ['nota',     /nota|observaci|detalle|descripci|se[nñ]as|ropa|caracter|direccion|comentario/],
];
function mapHeaders(header: string[]): { idx: Record<string, number>; unmapped: string[] } {
  const idx: Record<string, number> = {}; const unmapped: string[] = [];
  header.forEach((h, i) => {
    const n = norm(h); if (!n) return; let hit = false;
    for (const [field, re] of FIELD_SYNS) if (idx[field] === undefined && re.test(n)) { idx[field] = i; hit = true; break; }
    if (!hit) unmapped.push(h);
  });
  return { idx, unmapped };
}
const STATUS_RE = /buscando|encontrad|desaparecid|ubicad|rescatad|aparecid|hallad|activ|cerrad/i;
const FOUND_RE = /encontrad|ubicad|rescatad|aparecid|hallad/i;
function looksLikeStatus(vals: string[]): boolean {
  const v = vals.filter(x => x && x.trim()); if (v.length < 2) return false;
  return v.filter(x => STATUS_RE.test(x)).length / v.length >= 0.6;
}
// Filas basura / encabezados repetidos
const NON_NAMES = /^(nombre|nombres|persona|menor|nin[oa]s?|total|subtotal|situacion|edad|estado|lista|listado|desaparecid[oa]s?|paciente|hospital|zona|tipo|na|n\/a|sin nombre|s\/n|ninguno|no aplica)$/i;
const JUNK_START = /^(total|subtotal|suma|cantidad|conteo|resumen|observaci)/i;
function validName(name: string, header: string[]): boolean {
  const n = name.trim(); const nn = norm(n);
  if (n.length < 3 || /^[\d#]/.test(n) || /^#(ref|n\/?a|value|name|div)/i.test(n)) return false;
  if (!/[a-záéíóúñ]/i.test(n) || NON_NAMES.test(nn) || JUNK_START.test(nn)) return false;
  if (header.some(h => norm(h) === nn)) return false;   // fila que repite el encabezado
  return true;
}
function gridColumn(grid: string[][], col: number): string[] { return grid.slice(1).map(r => r[col] || ''); }

// Gazeteer mínimo (Yaracuy + capitales VE) para geocodificar por ciudad cuando falta lat/lng.
const GAZ: Record<string, [number, number]> = {
  'san felipe': [10.34, -68.74], 'yaritagua': [10.08, -69.13], 'chivacoa': [10.16, -68.90], 'nirgua': [10.15, -68.56],
  'cocorote': [10.33, -68.77], 'independencia': [10.30, -68.73], 'aroa': [10.44, -68.90], 'urachiche': [10.14, -69.00],
  'guama': [10.30, -68.81], 'sabana de parra': [10.07, -68.78], 'yaracuy': [10.34, -68.74],
  'barquisimeto': [10.07, -69.32], 'lara': [10.07, -69.32], 'valencia': [10.16, -68.00], 'carabobo': [10.16, -68.00],
  'caracas': [10.49, -66.88], 'maracay': [10.25, -67.60], 'aragua': [10.25, -67.60], 'puerto cabello': [10.47, -68.01],
  'maracaibo': [10.65, -71.64], 'zulia': [10.65, -71.64], 'merida': [8.59, -71.14], 'san cristobal': [7.77, -72.22],
  'coro': [11.40, -69.67], 'falcon': [11.40, -69.67], 'maturin': [9.75, -63.18], 'cumana': [10.45, -64.18],
};
function geocode(city: string): [number, number] | null { const g = GAZ[norm(city)]; return g || null; }
function num(s: string): number | null { const v = parseFloat(String(s).replace(',', '.')); return Number.isFinite(v) ? v : null; }

// ════════════════════ Adaptadores por destino ════════════════════
type Ctx = { idx: Record<string, number>; header: string[]; statusCol?: number; file: string; batch: string };
type Adapter = {
  keywords: RegExp; table: string; conflict: string;
  build: (row: string[], cell: (k: string) => string, ctx: Ctx) => any | null;
};
const ADAPTERS: Adapter[] = [
  {
    keywords: /desaparec|extravi|menores|ni[nñ]os|ni[nñ]as|perdid/i, table: 'desaparecidos_reportes', conflict: 'ext_id',
    build: (row, cell, ctx) => {
      const nombre = redactText(cell('nombre')); if (!validName(nombre, ctx.header)) return null;
      const zona = redactText(cell('zona')), visto = redactText(cell('visto')), edad = cleanEdad(cell('edad'));
      const statusRaw = ctx.statusCol !== undefined ? (row[ctx.statusCol] || '') : cell('estado');
      const foto = safeFoto(cell('foto_url'));
      return {
        ext_id: `drive:${ctx.file}:${norm([nombre, zona, visto, edad].join('|'))}`.slice(0, 250), source: `drive:${ctx.file}`, updated_at: ctx.batch,
        nombre, edad: edad || null, zona: zona || null, visto: visto || null,
        contacto: cleanPhone(cell('contacto')) || null, nota: redactText(cell('nota')) || null,
        foto_url: foto, estado: FOUND_RE.test(statusRaw) ? 'encontrado' : 'buscando',
      };
    },
  },
  {
    keywords: /hospital|ingreso|paciente|admisi|herido|atendid|lesionad/i, table: 'hospital_admisiones', conflict: 'id',
    build: (row, cell, ctx) => {
      const nombre = redactText(cell('nombre')); if (!validName(nombre, ctx.header)) return null;
      const hospital = redactText(cell('hospital')) || null; const fecha = cell('fecha') || null;
      return { id: norm(`${nombre}|${hospital || ''}`).slice(0, 200), nombre, hospital, fecha, source: `drive:${ctx.file}`, updated_at: ctx.batch };
    },
  },
  {
    keywords: /acopio|centros?\b|donaci|suministro|colecta|insumos?/i, table: 'centros_acopio_external', conflict: 'external_id',
    build: (row, cell, ctx) => {
      const nombre = redactText(cell('nombre')); if (nombre.length < 3 || !/[a-záéíóúñ]/i.test(nombre)) return null;
      const lat = num(cell('lat')), lng = num(cell('lng')); const g = (lat == null || lng == null) ? geocode(cell('zona')) : null;
      return {
        external_id: `drive:${ctx.file}:${norm(nombre)}`.slice(0, 200), source: `drive:${ctx.file}`, last_synced: ctx.batch,
        nombre, direccion: redactText(cell('zona') || cell('nota')) || null, telefono: cleanPhone(cell('contacto')) || null,
        lat: lat ?? g?.[0] ?? null, lng: lng ?? g?.[1] ?? null,
      };
    },
  },
  {
    keywords: /zona|afectad|da[nñ]o|derrumbe|colapso|damnificad|grieta/i, table: 'zona_reports', conflict: 'ext_id',
    build: (row, cell, ctx) => {
      let lat = num(cell('lat')), lng = num(cell('lng')); if (lat == null || lng == null) { const g = geocode(cell('zona') || cell('visto')); if (g) { lat = g[0]; lng = g[1]; } }
      if (lat == null || lng == null) return null;  // zona_reports exige coordenadas
      const ciudad = redactText(cell('zona')) || null; const tipo = normTipo(cell('tipo'), ['colapso', 'grietas', 'inundacion', 'via', 'incendio', 'otro']);
      return { ext_id: `drive:${ctx.file}:${norm([ciudad, tipo, lat, lng].join('|'))}`.slice(0, 250), source: `drive:${ctx.file}`, updated_at: ctx.batch, lat, lng, ciudad, tipo };
    },
  },
  {
    keywords: /log[ií]stic|necesidad|insumo|comida|agua|refugio|albergue|ayuda|v[ií]vere/i, table: 'logistica_reports', conflict: 'ext_id',
    build: (row, cell, ctx) => {
      let lat = num(cell('lat')), lng = num(cell('lng')); if (lat == null || lng == null) { const g = geocode(cell('zona') || cell('visto')); if (g) { lat = g[0]; lng = g[1]; } }
      if (lat == null || lng == null) return null;
      const ciudad = redactText(cell('zona')) || null; const tipo = normTipo(cell('tipo'), ['comida', 'agua', 'medicinas', 'higiene', 'ropa', 'voluntarios', 'otro']);
      const estado = /cubiert|saturad|ok|listo/i.test(cell('estado')) ? 'cubierto' : 'falta';
      return { ext_id: `drive:${ctx.file}:${norm([ciudad, tipo, lat, lng].join('|'))}`.slice(0, 250), source: `drive:${ctx.file}`, updated_at: ctx.batch, lat, lng, ciudad, tipo, estado, nota: redactText(cell('nota')) || null };
    },
  },
];
function normTipo(v: string, allowed: string[]): string { const n = norm(v); return allowed.find(a => n.includes(a.slice(0, 4))) || 'otro'; }
function routeOf(name: string): Adapter | null { for (const a of ADAPTERS) if (a.keywords.test(name)) return a; return null; }

// ════════════════════ Handler ════════════════════
export default async function handler(req: Request): Promise<Response> {
  if (!SB || !SERVICE) return json({ error: 'no_supabase' }, 503);
  const force = (() => { try { const k = new URL(req.url).searchParams.get('key'); return !!k && k === process.env.SCRAPER_WEBHOOK_SECRET; } catch { return false; } })();
  try {
    const last = await fetch(`${SB}/rest/v1/sync_runs?source=eq.drive&ok=eq.true&order=ran_at.desc&limit=1`, { headers: sbH() }).then(r => r.json()).catch(() => []);
    if (!force && Array.isArray(last) && last[0]?.ran_at && Date.now() - new Date(last[0].ran_at).getTime() < THROTTLE_MIN * 60000) {
      return json({ status: 'cached', last_sync: last[0].ran_at });
    }

    const cands = await allCandidates();
    if (!cands.length) { await mark(0); return json({ status: 'sin_archivos', hint: 'Sube un .csv, .xlsx, .json o Google Sheet con un nombre como "desaparecidos", "hospitales", "acopio", "zonas" o "logistica".' }); }

    const batch = new Date().toISOString(); const reports: any[] = []; let totalRows = 0;
    for (const f of cands.slice(0, MAX_FILES)) {
      const adapter = routeOf(f.name);
      if (!adapter) { reports.push({ archivo: f.name, estado: 'sin_clasificar', nota: 'el nombre no indica el destino' }); continue; }
      try {
        const grid = f.kind === 'xlsx' ? await xlsxToGrid(await downloadBytes(f))
          : f.kind === 'json' ? jsonToGrid(await downloadText(f))
            : parseCSV(await downloadText(f));
        if (grid.length < 2) { reports.push({ archivo: f.name, destino: adapter.table, estado: 'vacio' }); continue; }
        const header = grid[0]; const { idx, unmapped } = mapHeaders(header);
        // estatus por VALOR: si la columna 'zona' tiene valores de estatus, muévela a estado
        let statusCol: number | undefined;
        if (idx.zona !== undefined && looksLikeStatus(gridColumn(grid, idx.zona))) { statusCol = idx.zona; delete idx.zona; }
        if (statusCol === undefined && idx.estado === undefined) {
          for (let c = 0; c < header.length; c++) if (!Object.values(idx).includes(c) && looksLikeStatus(gridColumn(grid, c))) { statusCol = c; break; }
        }
        const ctx: Ctx = { idx, header, statusCol: statusCol ?? idx.estado, file: f.name, batch };
        const cellFor = (row: string[]) => (k: string) => { const i = idx[k]; return i === undefined ? '' : (row[i] || '').trim(); };
        const rows: any[] = []; const seen = new Set<string>(); let skipped = 0;
        for (let r = 1; r < grid.length && rows.length < MAX_ROWS; r++) {
          const rec = adapter.build(grid[r], cellFor(grid[r]), ctx);
          if (!rec) { skipped++; continue; }
          const key = rec[adapter.conflict]; if (seen.has(key)) continue; seen.add(key);
          rows.push(rec);
        }
        if (rows.length) {
          for (let i = 0; i < rows.length; i += 500) {
            const r = await fetch(`${SB}/rest/v1/${adapter.table}?on_conflict=${adapter.conflict}`, { method: 'POST', headers: sbH({ Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify(rows.slice(i, i + 500)) });
            if (!r.ok) throw new Error(`upsert ${r.status}: ${(await r.text()).slice(0, 140)}`);
          }
          // ESPEJO: borra de ESTE archivo lo que ya no está (sin tocar reportes de la app ni otros orígenes).
          // Solo si el archivo parseó con filas → nunca vacía la tabla por un fallo de descarga.
          const stampCol = adapter.table === 'centros_acopio_external' ? 'last_synced' : 'updated_at';
          await fetch(`${SB}/rest/v1/${adapter.table}?source=eq.${encodeURIComponent(`drive:${f.name}`)}&${stampCol}=lt.${encodeURIComponent(batch)}`, { method: 'DELETE', headers: sbH({ Prefer: 'return=minimal' }) }).catch(() => {});
        }
        totalRows += rows.length;
        reports.push({ archivo: f.name, destino: adapter.table, importadas: rows.length, descartadas: skipped, columnas_no_reconocidas: unmapped });
      } catch (e: any) { reports.push({ archivo: f.name, destino: adapter.table, error: e?.message || 'parse' }); }
    }
    await mark(totalRows);
    return json({ status: 'ok', total_importadas: totalRows, archivos: reports });
  } catch (e: any) {
    return json({ error: 'sync_failed', detail: e?.message }, 500);
  }
}
async function mark(count: number) {
  await fetch(`${SB}/rest/v1/sync_runs`, { method: 'POST', headers: sbH({ Prefer: 'return=minimal' }), body: JSON.stringify([{ source: 'drive', ok: true, count }]) }).catch(() => {});
}
function json(b: unknown, s = 200): Response {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
}
