/**
 * SismoVE · Listado COMPLETO del Google Drive (hospitales) — recursivo 1 nivel
 *
 * Lista la carpeta pública vía embeddedfolderview (SIN API key) y recorre también
 * las subcarpetas (p. ej. por hospital) para devolver TODO: docs, PDFs e imágenes.
 * Solo enlaza a la fuente oficial (no republica contenido). Cache CDN ~30 min.
 */
export const config = { runtime: 'edge' };

const FOLDERS = (process.env.DRIVE_FOLDER_IDS || process.env.DRIVE_FOLDER_ID || '1o36ifaRz45kAs5rKzci49aD0mP5JB_YI,1OIUMzrZzRpcTTE8olKT0lk6-jRFO3ztM').split(',').map(s => s.trim()).filter(Boolean);
const ENTRY_RE = /<div class="flip-entry"[^>]*id="entry-([^"]+)"[\s\S]*?<a href="([^"]+)"[\s\S]*?<div class="flip-entry-title">([^<]*)<\/div>/g;

function tipoOf(url: string, name: string): string {
  if (url.includes('/drive/folders/')) return 'carpeta';
  if (url.includes('/document/')) return 'documento';
  if (url.includes('/spreadsheets/')) return 'hoja';
  if (/\.pdf$/i.test(name)) return 'pdf';
  if (/\.(jpe?g|png|webp|gif|heic)$/i.test(name)) return 'imagen';
  if (/\.(mp4|mov|webm|avi)$/i.test(name)) return 'video';
  return 'archivo';
}

async function listFolder(id: string) {
  const html = await (await fetch(`https://drive.google.com/embeddedfolderview?id=${id}#list`, { headers: { 'User-Agent': 'Mozilla/5.0 (SismoVE)' } })).text();
  const items: any[] = []; let m: RegExpExecArray | null; ENTRY_RE.lastIndex = 0;
  while ((m = ENTRY_RE.exec(html)) !== null) {
    const name = m[3].trim(); if (!name) continue;
    items.push({ id: m[1], name, url: m[2], tipo: tipoOf(m[2], name) });
  }
  return items;
}

export default async function handler(): Promise<Response> {
  try {
    const carpetas: any[] = [];
    for (const FOLDER of FOLDERS) {
      let items: any[] = [];
      try { items = await listFolder(FOLDER); } catch { continue; }
      // Recursión 1 nivel: contenido de cada subcarpeta
      await Promise.all(items.filter(i => i.tipo === 'carpeta').map(async it => {
        try { it.children = await listFolder(it.id); } catch { it.children = []; }
      }));
      carpetas.push({ folder_url: `https://drive.google.com/drive/folders/${FOLDER}`, items });
    }
    const total = carpetas.reduce((n, c) => n + c.items.reduce((m: number, it: any) => m + 1 + (it.children ? it.children.length : 0), 0), 0);
    return json({ count: total, carpetas, fetched_at: new Date().toISOString() });
  } catch (e: any) {
    return json({ error: 'drive_unreachable', detail: e?.message, carpetas: [] }, 502);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=600' },
  });
}
