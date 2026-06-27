/**
 * SismoVE · Cifras agregadas para la portada (auto-actualizadas cada 30 min).
 *
 * Fuente PRINCIPAL: redayudavenezuela.com (datos abiertos) — agrega 105k+ registros de
 * varias fuentes (incl. terremotovenezuela.app) en Supabase público:
 *   missing_persons.status = 'active' → desaparecidos / aún sin contacto
 *                            'found'  → localizados
 *   official_stats / /api/official    → fallecidos, heridos (cifra oficial vía Wikipedia)
 * NO se scrapea desaparecidosterremotovenezuela.com: su API exige reCAPTCHA (anti-bot) y
 * no saltamos protecciones; solo se ENLAZA como fuente. Atribución visible en la portada.
 *
 * Guarda en nuestra tabla `cifras` (1 fila) y la sirve a la portada. El cron refresca con
 * ?key=SCRAPER_WEBHOOK_SECRET (throttle 30 min). GET sin key devuelve lo guardado (rápido).
 */
export const config = { runtime: 'edge' };

const SB = process.env.SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SECRET = process.env.SCRAPER_WEBHOOK_SECRET;
const REFRESH_MIN = 30;
// redayuda: backend público (anon key pública, ya expuesta en su propio sitio)
const RED_SB = 'https://cpavwkdonvkvrwygfzfo.supabase.co';
const RED_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNwYXZ3a2RvbnZrdnJ3eWdmemZvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIzNjAyODMsImV4cCI6MjA5NzkzNjI4M30.-_FAsA2csTrB9qt267pBfjJkczMP7pcaUi4plMv3kv4';

function sbH(extra: Record<string, string> = {}) {
  return { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...extra };
}
async function redCount(query: string): Promise<number | null> {
  try {
    const r = await fetch(`${RED_SB}/rest/v1/missing_persons?${query}`, { headers: { apikey: RED_ANON, Authorization: `Bearer ${RED_ANON}`, Prefer: 'count=exact', Range: '0-0' }, method: 'HEAD' });
    const n = parseInt((r.headers.get('content-range') || '').split('/')[1] || '', 10);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}
async function scrape() {
  const [desap, local, total] = await Promise.all([
    redCount('status=eq.active&select=id'),
    redCount('status=eq.found&select=id'),
    redCount('select=id'),
  ]);
  let fallecidos: number | null = null, heridos: number | null = null;
  try {
    const o: any = await fetch('https://redayudavenezuela.com/api/official', { headers: { 'User-Agent': 'Mozilla/5.0 (SismoVE)' } }).then(r => r.json());
    fallecidos = o?.applied?.fallecidos ?? o?.parsed?.deaths ?? null;
    heridos = o?.applied?.heridos ?? o?.parsed?.injured ?? null;
  } catch {}
  if (fallecidos == null || heridos == null) {   // respaldo: tabla official_stats de redayuda
    try {
      const os: any = await fetch(`${RED_SB}/rest/v1/official_stats?id=eq.1&select=fallecidos,heridos`, { headers: { apikey: RED_ANON, Authorization: `Bearer ${RED_ANON}` } }).then(r => r.json());
      if (Array.isArray(os) && os[0]) { fallecidos = fallecidos ?? os[0].fallecidos; heridos = heridos ?? os[0].heridos; }
    } catch {}
  }
  return { desaparecidos: desap, localizados: local, total, fallecidos, heridos };
}
async function stored(): Promise<any | null> {
  const r = await fetch(`${SB}/rest/v1/cifras?id=eq.1&select=*`, { headers: sbH() }).then(x => x.json()).catch(() => []);
  return Array.isArray(r) && r[0] ? r[0] : null;
}

export default async function handler(req: Request): Promise<Response> {
  if (!SB || !SERVICE) return json({ error: 'no_supabase' }, 503);
  const url = (() => { try { return new URL(req.url); } catch { return null; } })();
  const force = !!url && (url.searchParams.get('key') === SECRET || url.searchParams.get('refresh') === '1');
  const cur = await stored();
  // GET normal (portada): devuelve lo guardado sin scrapear (rápido). Solo scrapea en 1ª vez.
  if (!force && cur) return json(out(cur), 200, 'public, s-maxage=120, stale-while-revalidate=600');
  if (!force && !cur) { /* primera vez: scrape para sembrar */ }
  // throttle 30 min aun con key (el cron pega cada 10)
  if (force && cur?.updated_at && Date.now() - new Date(cur.updated_at).getTime() < REFRESH_MIN * 60000 && url?.searchParams.get('refresh') !== '1') {
    return json(out(cur));
  }
  const s = await scrape();
  // no pisar con null si la fuente falló: conserva el último valor bueno
  const merged = {
    id: 1,
    desaparecidos: s.desaparecidos ?? cur?.desaparecidos ?? null,
    localizados: s.localizados ?? cur?.localizados ?? null,
    total: s.total ?? cur?.total ?? null,
    fallecidos: s.fallecidos ?? cur?.fallecidos ?? null,
    heridos: s.heridos ?? cur?.heridos ?? null,
    updated_at: new Date().toISOString(),
  };
  // NO incluir dtv en el upsert (es manual) → no lo pisamos en cada scrape.
  await fetch(`${SB}/rest/v1/cifras?on_conflict=id`, { method: 'POST', headers: sbH({ Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify([merged]) }).catch(() => {});
  return json(out({ ...merged, dtv: cur?.dtv ?? null }));
}
function out(c: any) {
  return {
    // redayuda (en vivo)
    desaparecidos: c.desaparecidos, localizados: c.localizados, total: c.total,
    fallecidos: c.fallecidos, heridos: c.heridos, updated_at: c.updated_at,
    // desaparecidosterremoto (manual, jsonb dtv)
    dtv: c.dtv ?? null,
    fuentes: [
      { nombre: 'Red Ayuda Venezuela', url: 'https://redayudavenezuela.com/' },
      { nombre: 'Desaparecidos Terremoto Venezuela', url: 'https://desaparecidosterremotovenezuela.com/' },
    ],
  };
}
function json(b: unknown, s = 200, cache = 'no-store'): Response {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': cache } });
}
