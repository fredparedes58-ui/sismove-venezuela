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
// Varias carpetas (separadas por coma). Por defecto: la original + la nueva ("AGENTE").
const FOLDERS = (process.env.DRIVE_FOLDER_IDS || process.env.DRIVE_FOLDER_ID || '1o36ifaRz45kAs5rKzci49aD0mP5JB_YI,1OIUMzrZzRpcTTE8olKT0lk6-jRFO3ztM').split(',').map(s => s.trim()).filter(Boolean);
const MAX_DEPTH = 4;          // recorre subcarpetas (y sub-sub…) hasta esta profundidad
const MAX_FOLDERS = 80;       // tope de carpetas visitadas por corrida (evita timeouts)
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
// Recorre TODAS las carpetas (FOLDERS) de forma recursiva (raíz + subcarpetas anidadas).
async function allCandidates() {
  const out: { id: string; name: string; kind: Kind }[] = [];
  const seenFolders = new Set<string>(); let visited = 0;
  const queue: { id: string; depth: number }[] = FOLDERS.map(id => ({ id, depth: 0 }));
  while (queue.length && visited < MAX_FOLDERS) {
    const { id, depth } = queue.shift()!;
    if (seenFolders.has(id)) continue; seenFolders.add(id); visited++;
    let entries: { id: string; name: string; url: string }[] = [];
    try { entries = await listFolder(id); } catch { continue; }
    for (const e of entries) {
      if (e.url.includes('/drive/folders/')) { if (depth < MAX_DEPTH && !seenFolders.has(e.id)) queue.push({ id: e.id, depth: depth + 1 }); }
      else { const k = kindOf(e.name, e.url); if (k) out.push({ id: e.id, name: e.name, kind: k }); }
    }
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
    const token = (txt.match(/confirm=([0-9A-Za-z_-]+)/) || [])[1] || 't';
    r = await fetch(`https://drive.usercontent.google.com/download?id=${f.id}&export=download&confirm=${token}`, { headers: { 'User-Agent': 'Mozilla/5.0 (SismoVE)' } });
    txt = await r.text();
    if (isHtml(txt)) throw new Error('drive_html');
  } else if (!r.ok) throw new Error('download ' + r.status);
  return txt;
}
async function downloadBytes(f: { id: string }): Promise<ArrayBuffer> {
  let r = await fetch(`https://drive.google.com/uc?export=download&id=${f.id}`, { headers: { 'User-Agent': 'Mozilla/5.0 (SismoVE)' } });
  let buf = await r.arrayBuffer();
  // ¿interstitial? Decodifica 4KB (no 64 B): el token confirm= aparece dentro del HTML, no al inicio.
  const head = new TextDecoder().decode(new Uint8Array(buf.slice(0, 4096)));
  if (isHtml(head)) {
    const token = (head.match(/confirm=([0-9A-Za-z_-]+)/) || [])[1] || 't';
    r = await fetch(`https://drive.usercontent.google.com/download?id=${f.id}&export=download&confirm=${token}`, { headers: { 'User-Agent': 'Mozilla/5.0 (SismoVE)' } });
    buf = await r.arrayBuffer();
  } else if (!r.ok) throw new Error('download ' + r.status);
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
// INFLATE (raw DEFLATE) en JS puro, estilo "puff". Vercel Edge NO expone DecompressionStream,
// así que descomprimimos sin dependencias. Validado byte-a-byte contra zlib.
function inflateRaw(source: Uint8Array): Uint8Array {
  let bitBuf = 0, bitCnt = 0, pos = 0; const out: number[] = [];
  const getBit = () => { if (bitCnt === 0) { bitBuf = source[pos++]; bitCnt = 8; } const b = bitBuf & 1; bitBuf >>= 1; bitCnt--; return b; };
  const getBits = (n: number) => { let v = 0; for (let i = 0; i < n; i++) v |= getBit() << i; return v >>> 0; };
  const construct = (lengths: number[], n: number) => { const count = new Array(16).fill(0); for (let i = 0; i < n; i++) count[lengths[i]]++; const symbol = new Array(n); const offs = new Array(16).fill(0); for (let len = 1; len < 15; len++) offs[len + 1] = offs[len] + count[len]; for (let i = 0; i < n; i++) if (lengths[i]) symbol[offs[lengths[i]]++] = i; return { count, symbol }; };
  const decode = (h: any) => { let code = 0, first = 0, index = 0; for (let len = 1; len <= 15; len++) { code |= getBit(); const c = h.count[len]; if (code - c < first) return h.symbol[index + (code - first)]; index += c; first += c; first <<= 1; code <<= 1; } throw new Error('bad_code'); };
  const lenBase = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const lenExtra = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const distBase = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  const distExtra = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  let last: number;
  do {
    last = getBit(); const type = getBits(2);
    if (type === 0) { bitCnt = 0; const len = source[pos] | (source[pos + 1] << 8); pos += 4; for (let i = 0; i < len; i++) out.push(source[pos++]); }
    else {
      let lenTree: any, distTree: any;
      if (type === 1) { const ll = new Array(288); for (let i = 0; i < 144; i++) ll[i] = 8; for (let i = 144; i < 256; i++) ll[i] = 9; for (let i = 256; i < 280; i++) ll[i] = 7; for (let i = 280; i < 288; i++) ll[i] = 8; lenTree = construct(ll, 288); distTree = construct(new Array(30).fill(5), 30); }
      else if (type === 2) {
        const hlit = getBits(5) + 257, hdist = getBits(5) + 1, hclen = getBits(4) + 4;
        const order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
        const cl = new Array(19).fill(0); for (let i = 0; i < hclen; i++) cl[order[i]] = getBits(3);
        const clTree = construct(cl, 19); const lengths = new Array(hlit + hdist).fill(0); let i = 0;
        while (i < hlit + hdist) { const s = decode(clTree); if (s < 16) lengths[i++] = s; else if (s === 16) { const r = getBits(2) + 3, p = lengths[i - 1]; for (let j = 0; j < r; j++) lengths[i++] = p; } else if (s === 17) { const r = getBits(3) + 3; for (let j = 0; j < r; j++) lengths[i++] = 0; } else { const r = getBits(7) + 11; for (let j = 0; j < r; j++) lengths[i++] = 0; } }
        lenTree = construct(lengths.slice(0, hlit), hlit); distTree = construct(lengths.slice(hlit), hdist);
      } else throw new Error('bad_block');
      while (true) { const sym = decode(lenTree); if (sym === 256) break; if (sym < 256) out.push(sym); else { const s = sym - 257; const len = lenBase[s] + getBits(lenExtra[s]); const ds = decode(distTree); const dist = distBase[ds] + getBits(distExtra[ds]); let from = out.length - dist; for (let j = 0; j < len; j++) out.push(out[from++]); } }
    }
  } while (!last);
  return new Uint8Array(out);
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
  while ((nf = nfRe.exec(styleXml)) !== null) { const code = decodeEntities(nf[2]).replace(/"[^"]*"|\[[^\]]*\]/g, ''); if (/yy|y{4}|dd|mm|hh|ss|[dmy][\/\-. ]|[\/\-. ][dmy]/i.test(code)) customDate.add(parseInt(nf[1], 10)); }
  const builtin = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
  const xfsBlock = (styleXml.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/) || [, ''])[1]; let xf: any, xi = 0; const xfRe = /<xf\b[^>]*numFmtId="(\d+)"[^>]*\/?>/g;
  while ((xf = xfRe.exec(xfsBlock)) !== null) { const id = parseInt(xf[1], 10); if (builtin.has(id) || customDate.has(id)) dateStyles.add(xi); xi++; }
  // primera hoja
  const wb = await zipRead(zip, 'xl/workbook.xml'); const rels = await zipRead(zip, 'xl/_rels/workbook.xml.rels'); let sheetPath = 'xl/worksheets/sheet1.xml';
  if (wb && rels) { const rid = (wb.match(/<sheet\b[^>]*r:id="([^"]+)"/) || [])[1]; if (rid) { const tgt = (rels.match(new RegExp(`<Relationship[^>]*Id="${rid}"[^>]*Target="([^"]+)"`)) || [])[1]; if (tgt) sheetPath = 'xl/' + tgt.replace(/^\/?xl\//, '').replace(/^\//, ''); } }
  const sheet = await zipRead(zip, sheetPath) || ''; const grid: string[][] = [];
  let r: any; const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  while ((r = rowRe.exec(sheet)) !== null) {
    const cells: string[] = []; let col = 0; let c: any; const cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
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
      const ci = ref ? colOf(ref) : col;     // sin r=: avanza secuencial (no cells.length, que mezcla huecos)
      cells[ci] = val; col = ci + 1;
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
    grid.push(cells);
  }
  return grid.filter(row => row.some(c => String(c).trim()));
}

// ════════════════════ Helpers de saneo / mapeo ════════════════════
const norm = (s: string) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

// Patrones de documento de identidad venezolano (cédula/pasaporte) — se REDACTAN siempre.
const DOC_RE = /[vejpg][-\s.]?\d{1,2}[.\s]?\d{3}[.\s]?\d{3}|\d{1,3}[.\s]\d{3}[.\s]\d{3}|(?:c[ií]|c\.i|cedula|cédula|dni|documento|pasaporte|rif)\b[:\s.\-]*[\w.\-]*\d{5,}/gi;
const DIGRUN_RE = /\d{6,}/g;   // cualquier corrida de 6+ dígitos (cédula 6-9 / pasaporte / sin \b para pillar embebidos)
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
function hostAllowed(host: string): boolean {
  // Coincidencia EXACTA con frontera de punto (evita bypass tipo evilgoogle.com)
  return host === 'drive.google.com' || host === 'drive.usercontent.google.com' || host === 'docs.google.com'
    || host === 'lh3.googleusercontent.com' || host.endsWith('.googleusercontent.com')
    || host === SB_HOST;
}
function safeFoto(u: string): string | null {
  const url = String(u).trim(); if (!/^https:\/\//i.test(url)) return null;
  let host = ''; try { host = new URL(url).host.toLowerCase(); } catch { return null; }
  if (!hostAllowed(host)) return null;
  return host === SB_HOST ? url : fixDriveImg(url);
}
// Encabezados → campo (por INCLUSIÓN; cada columna a UN solo campo)
const FIELD_SYNS: [string, RegExp][] = [
  ['nombre',    /nombre|^persona$|^menor$|^nin[oa]s?$|desaparecid|^paciente$|apellid/],
  ['edad',      /edad|^a[nñ]os$/],
  ['lat',       /^lat|latitud/],
  ['lng',       /^lon|^lng|longitud/],
  ['hospital',  /hospital|cl[ií]nic|centro de salud|^centro$|ambulatorio|asistencial/],
  ['fecha',     /fecha|\bd[ií]a\b/],
  ['contacto',  /tel[eé]fono|tlf|celular|whatsapp|m[oó]vil|contacto/],
  ['direccion', /direcci|^calle|avenida|^av\b|carrera|punto de referencia|domicilio/],
  ['zona',      /zona|ciudad|estado|^edo\b|municipio|localidad|sector|parroquia|entidad/],
  ['visto',     /ultima vez|visto|d[oó]nde|ubicaci[oó]n|^lugar|desaparici|desaparecio|^punto/],
  ['tipo',      /tipo|categor[ií]a|necesidad|insumo|recurso/],
  ['estado',    /situaci[oó]n|estatus|status|condici[oó]n/],
  ['foto_url',  /foto|imagen|^photo$|url|enlace|link/],
  ['nota',      /nota|observaci|detalle|descripci|se[nñ]as|ropa|caracter|comentario/],
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
  if (/\d{5,}/.test(n)) return false;                   // dígitos residuales tras redactar → posible documento colado
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
// `file` = ID de Drive (estable ante rename); `fileName` = nombre legible (solo reporte).
type Ctx = { idx: Record<string, number>; header: string[]; statusCol?: number; file: string; fileName: string; batch: string };
const NOCOORDS = Symbol('nocoords');   // fila válida pero descartada por faltar lat/lng (para desglosar el reporte)
type Adapter = {
  keywords: RegExp; table: string; conflict: string;
  build: (row: string[], cell: (k: string) => string, ctx: Ctx) => any | typeof NOCOORDS | null;
};
// OJO orden: logística ANTES que zona (un archivo "insumos por zona" es logística, no daño
// estructural); hospitales ANTES que acopio (un "centro de salud" es hospital, no acopio).
const ADAPTERS: Adapter[] = [
  {
    keywords: /desaparec|extravi|menores|ni[nñ]os|ni[nñ]as|perdid/i, table: 'desaparecidos_reportes', conflict: 'ext_id',
    build: (row, cell, ctx) => {
      const nombre = redactText(cell('nombre')); if (!validName(nombre, ctx.header)) return null;
      const zona = redactText(cell('zona')), visto = redactText(cell('visto')), edad = cleanEdad(cell('edad'));
      const statusRaw = ctx.statusCol !== undefined ? (row[ctx.statusCol] || '') : cell('estado');
      return {
        ext_id: `drive:${ctx.file}:${norm([nombre, zona, visto, edad].join('|'))}`.slice(0, 250), source: `drive:${ctx.file}`, updated_at: ctx.batch,
        nombre, edad: edad || null, zona: zona || null, visto: visto || null,
        contacto: cleanPhone(cell('contacto')) || null, nota: redactText(cell('nota') || cell('direccion')) || null,
        foto_url: safeFoto(cell('foto_url')), estado: FOUND_RE.test(statusRaw) ? 'encontrado' : 'buscando',
      };
    },
  },
  {
    keywords: /hospital|ingreso|paciente|admisi|herido|atendid|lesionad|centros? de salud|asistencial|ambulatorio|cl[ií]nica/i, table: 'hospital_admisiones', conflict: 'id',
    build: (row, cell, ctx) => {
      const nombre = redactText(cell('nombre')); if (!validName(nombre, ctx.header)) return null;
      const hospital = redactText(cell('hospital')) || null;
      return { id: norm(`${nombre}|${hospital || ''}`).slice(0, 200), nombre, hospital, fecha: redactText(cell('fecha')) || null, source: `drive:${ctx.file}`, updated_at: ctx.batch };
    },
  },
  {
    keywords: /acopio|donaci|colecta|suministro|centro de acopio/i, table: 'centros_acopio_external', conflict: 'external_id',
    build: (row, cell, ctx) => {
      const nombre = redactText(cell('nombre')); if (nombre.length < 3 || !/[a-záéíóúñ]/i.test(nombre)) return null;
      const lat = num(cell('lat')), lng = num(cell('lng')); const g = (lat == null || lng == null) ? geocode(cell('zona')) : null;
      return {
        external_id: `drive:${ctx.file}:${norm(nombre)}`.slice(0, 200), source: `drive:${ctx.file}`, last_synced: ctx.batch,
        nombre, direccion: redactText(cell('direccion') || cell('zona') || cell('nota')) || null, telefono: cleanPhone(cell('contacto')) || null,
        lat: lat ?? g?.[0] ?? null, lng: lng ?? g?.[1] ?? null,
      };
    },
  },
  {
    keywords: /log[ií]stic|necesidad|insumo|comida|agua|refugio|albergue|ayuda|v[ií]vere|damnificad/i, table: 'logistica_reports', conflict: 'ext_id',
    build: (row, cell, ctx) => {
      let lat = num(cell('lat')), lng = num(cell('lng')); if (lat == null || lng == null) { const g = geocode(cell('zona') || cell('direccion') || cell('visto')); if (g) { lat = g[0]; lng = g[1]; } }
      if (lat == null || lng == null) return NOCOORDS;
      const ciudad = redactText(cell('zona')) || null; const tipo = normTipo(cell('tipo'), ['comida', 'agua', 'medicinas', 'higiene', 'ropa', 'voluntarios', 'otro']);
      const estado = /cubiert|saturad|ok|listo/i.test(cell('estado')) ? 'cubierto' : 'falta';
      return { ext_id: `drive:${ctx.file}:${norm([ciudad, tipo, lat, lng].join('|'))}`.slice(0, 250), source: `drive:${ctx.file}`, updated_at: ctx.batch, lat, lng, ciudad, tipo, estado, nota: redactText(cell('nota')) || null };
    },
  },
  {
    keywords: /zona|afectad|da[nñ]o|derrumbe|colapso|grieta|estructura/i, table: 'zona_reports', conflict: 'ext_id',
    build: (row, cell, ctx) => {
      let lat = num(cell('lat')), lng = num(cell('lng')); if (lat == null || lng == null) { const g = geocode(cell('zona') || cell('direccion') || cell('visto')); if (g) { lat = g[0]; lng = g[1]; } }
      if (lat == null || lng == null) return NOCOORDS;  // zona_reports exige coordenadas
      const ciudad = redactText(cell('zona')) || null; const tipo = normTipo(cell('tipo'), ['colapso', 'grietas', 'inundacion', 'via', 'incendio', 'otro']);
      return { ext_id: `drive:${ctx.file}:${norm([ciudad, tipo, lat, lng].join('|'))}`.slice(0, 250), source: `drive:${ctx.file}`, updated_at: ctx.batch, lat, lng, ciudad, tipo };
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
    const nameRe = FIELD_SYNS.find(([k]) => k === 'nombre')![1];
    for (const f of cands.slice(0, MAX_FILES)) {
      const adapter = routeOf(f.name);
      if (!adapter) { reports.push({ archivo: f.name, estado: 'sin_clasificar', nota: 'el nombre no indica el destino' }); continue; }
      const sourceVal = `drive:${f.id}`;   // identidad por ID de Drive (estable ante rename)
      try {
        const grid = f.kind === 'xlsx' ? await xlsxToGrid(await downloadBytes(f))
          : f.kind === 'json' ? jsonToGrid(await downloadText(f))
            : parseCSV(await downloadText(f));
        if (grid.length < 2) { reports.push({ archivo: f.name, destino: adapter.table, estado: 'vacio' }); continue; }
        const header = grid[0]; const { idx, unmapped } = mapHeaders(header);
        // Concatena TODAS las columnas de nombre (p.ej. Apellidos + Nombres) → no pierde la mitad
        const nombreCols = header.map((_, i) => i).filter(i => nameRe.test(norm(header[i])));
        // estatus por VALOR: si la columna 'zona' tiene valores de estatus, muévela a estado
        let statusCol: number | undefined;
        if (idx.zona !== undefined && looksLikeStatus(gridColumn(grid, idx.zona))) { statusCol = idx.zona; delete idx.zona; }
        if (statusCol === undefined && idx.estado === undefined) {
          for (let c = 0; c < header.length; c++) if (!Object.values(idx).includes(c) && looksLikeStatus(gridColumn(grid, c))) { statusCol = c; break; }
        }
        const ctx: Ctx = { idx, header, statusCol: statusCol ?? idx.estado, file: f.id, fileName: f.name, batch };
        const cellFor = (row: string[]) => (k: string) => {
          if (k === 'nombre' && nombreCols.length) return nombreCols.map(i => (row[i] || '').trim()).filter(Boolean).join(' ');
          const i = idx[k]; return i === undefined ? '' : (row[i] || '').trim();
        };
        const rows: any[] = []; const seen = new Set<string>(); let basura = 0, sinCoords = 0;
        for (let r = 1; r < grid.length && rows.length < MAX_ROWS; r++) {
          const rec = adapter.build(grid[r], cellFor(grid[r]), ctx);
          if (rec === NOCOORDS) { sinCoords++; continue; }
          if (!rec) { basura++; continue; }
          const key = (rec as any)[adapter.conflict]; if (seen.has(key)) continue; seen.add(key);
          rows.push(rec);
        }
        let espejo = 'no_aplica';
        if (rows.length) {
          // cuántas filas tenía ESTE archivo antes (para detectar una descarga truncada)
          let prev = 0;
          try { const cr = await fetch(`${SB}/rest/v1/${adapter.table}?source=eq.${encodeURIComponent(sourceVal)}`, { method: 'HEAD', headers: sbH({ Prefer: 'count=exact', Range: '0-0' }) }); prev = parseInt((cr.headers.get('content-range') || '').split('/')[1] || '0', 10) || 0; } catch {}
          for (let i = 0; i < rows.length; i += 500) {
            const r = await fetch(`${SB}/rest/v1/${adapter.table}?on_conflict=${adapter.conflict}`, { method: 'POST', headers: sbH({ Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify(rows.slice(i, i + 500)) });
            if (!r.ok) { const t = (await r.text()).slice(0, 160); throw new Error(/does not exist|could not find the table|on conflict|42P10|PGRST20[45]/i.test(t) ? `falta crear la tabla / correr el SQL (schema_desaparecidos*.sql + schema_drive_sync.sql) [${r.status}]` : `upsert ${r.status}: ${t}`); }
          }
          // ESPEJO: borra de ESTE archivo (por ID) lo que ya no está. Guardas: solo si parseó filas,
          // nunca toca reportes de la app (source NULL) ni otros archivos, y NO borra si las filas
          // caen a <50% de lo previo (posible descarga parcial) → evita borrar gente por un fallo.
          const stampCol = adapter.table === 'centros_acopio_external' ? 'last_synced' : 'updated_at';
          if (prev > 0 && rows.length < prev * 0.5) { espejo = 'omitido_posible_descarga_truncada'; }
          else { await fetch(`${SB}/rest/v1/${adapter.table}?source=eq.${encodeURIComponent(sourceVal)}&${stampCol}=lt.${encodeURIComponent(batch)}`, { method: 'DELETE', headers: sbH({ Prefer: 'return=minimal' }) }).catch(() => {}); espejo = 'ok'; }
        }
        totalRows += rows.length;
        reports.push({ archivo: f.name, destino: adapter.table, importadas: rows.length, descartadas_basura: basura, descartadas_sin_coords: sinCoords, columnas_no_reconocidas: unmapped, espejo });
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
