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
  // FUENTE DE VERDAD (siempre disponible): la BD pública de redayuda (missing_persons por status).
  //   status=active → desaparecidos (coincide con el "Desaparecidos" del sitio); status=found → localizados.
  // (Su /api/stats antiguo dejó de devolver JSON —responde HTML— y daba un total inflado/obsoleto.)
  let desap: number | null = null, local: number | null = null;
  try { [desap, local] = await Promise.all([redCount('status=eq.active&select=id'), redCount('status=eq.found&select=id')]); } catch {}
  // EXTRA (best-effort): dashboard secundario (hospital/niños/voluntarios/…) vía /api/stats si aún responde JSON.
  let red: any = null, fallecidos: number | null = null, heridos: number | null = null;
  try {
    const txt = await fetch('https://redayudavenezuela.com/api/stats', { headers: { 'User-Agent': 'Mozilla/5.0 (SismoVE)', 'Accept': 'application/json' } }).then(r => r.text());
    const j: any = txt.trim().startsWith('{') ? JSON.parse(txt) : null;   // guarda: ignora HTML (429/redirect)
    if (j) {
      const st = j.stats || {}, off = j.official || {};
      red = {
        desaparecidos: desap ?? st.desaparecidos ?? null, localizados: local ?? null, hospital: st.hospital ?? null,
        salvo: st.salvo ?? null, ninos: j.ninos ?? null, denuncias: j.denuncias ?? null, voluntarios: st.voluntarios ?? null,
        necesidades: st.necesidades ?? null, atrapados: st.atrapados ?? null, danos: st.danos ?? null,
        heridos: off.heridos ?? null, fallecidos: off.fallecidos ?? null, puntos: st.puntos ?? null,
      };
      fallecidos = off.fallecidos ?? null; heridos = off.heridos ?? null;
    }
  } catch {}
  const total = (desap != null && local != null) ? desap + local : null;
  return { desaparecidos: desap, localizados: local, total, fallecidos, heridos, red };
}
async function stored(): Promise<any | null> {
  const r = await fetch(`${SB}/rest/v1/cifras?id=eq.1&select=*`, { headers: sbH() }).then(x => x.json()).catch(() => []);
  return Array.isArray(r) && r[0] ? r[0] : null;
}

export default async function handler(req: Request): Promise<Response> {
  if (!SB || !SERVICE) return json({ error: 'no_supabase' }, 503);
  const url = (() => { try { return new URL(req.url); } catch { return null; } })();
  const force = !!url && url.searchParams.get('key') === SECRET;   // SOLO con clave (cron); nunca anónimo
  const bypass = force && url.searchParams.get('refresh') === '1'; // key + refresh=1 → fuerza scrape (salta throttle)
  const cur = await stored();
  // GET normal (portada): devuelve lo guardado sin scrapear (rápido).
  if (!force && cur) return json(out(cur), 200, 'public, s-maxage=120, stale-while-revalidate=600');
  // throttle: el cron pega cada 10 min, pero solo re-scrapeamos cada 30 (salvo bypass con clave)
  if (force && !bypass && cur?.updated_at && Date.now() - new Date(cur.updated_at).getTime() < REFRESH_MIN * 60000) {
    return json(out(cur));
  }
  const s = await scrape();
  // no pisar con null si la fuente falló: conserva el último valor bueno
  const merged: any = {
    id: 1,
    desaparecidos: s.desaparecidos ?? cur?.desaparecidos ?? null,
    localizados: s.localizados ?? cur?.localizados ?? null,
    total: s.total ?? cur?.total ?? null,
    fallecidos: s.fallecidos ?? cur?.fallecidos ?? null,
    heridos: s.heridos ?? cur?.heridos ?? null,
    // dashboard live: usa /api/stats si respondió; si no, conserva el anterior PERO refresca
    // siempre desaparecidos/localizados desde la BD (para que NO queden obsoletos).
    red: (() => { const base = s.red || cur?.red || {}; return { ...base, desaparecidos: s.desaparecidos ?? base.desaparecidos ?? null, localizados: s.localizados ?? base.localizados ?? null }; })(),
    updated_at: new Date().toISOString(),
  };
  // NO incluir dtv/afe en el upsert (son manuales) → no se pisan en cada scrape.
  let r = await fetch(`${SB}/rest/v1/cifras?on_conflict=id`, { method: 'POST', headers: sbH({ Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify([merged]) });
  if (!r.ok) { delete merged.red; await fetch(`${SB}/rest/v1/cifras?on_conflict=id`, { method: 'POST', headers: sbH({ Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify([merged]) }).catch(() => {}); }  // si falta la col 'red', guarda al menos lo demás
  return json(out({ ...merged, dtv: cur?.dtv ?? null, afe: cur?.afe ?? null }));
}
function out(c: any) {
  return {
    // banner / compat
    desaparecidos: c.desaparecidos, localizados: c.localizados, total: c.total,
    fallecidos: c.fallecidos, heridos: c.heridos, updated_at: c.updated_at,
    red: c.red ?? null,   // Red Ayuda Venezuela (live, 11 marcadores)
    dtv: c.dtv ?? null,   // Desaparecidos Terremoto Venezuela (manual, 4)
    afe: c.afe ?? null,   // Afectados por el Terremoto · Balance oficial (manual, 6)
    fuentes: [
      { nombre: 'Red Ayuda Venezuela', url: 'https://redayudavenezuela.com/' },
      { nombre: 'Desaparecidos Terremoto Venezuela', url: 'https://desaparecidosterremotovenezuela.com/' },
      { nombre: 'Afectados por el Terremoto Venezuela', url: 'https://www.afectadosporelterremotovenezuela.com/' },
    ],
  };
}
function json(b: unknown, s = 200, cache = 'no-store'): Response {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': cache } });
}
