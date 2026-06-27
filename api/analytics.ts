/**
 * SismoVE · Panel de analítica (solo admin). GET ?key=ADMIN_KEY.
 * Lee analytics_events con service_role y devuelve conteos agregados (sin PII).
 */
export const config = { runtime: 'edge' };

const SB = process.env.SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ADMIN_KEY = process.env.ADMIN_KEY;
const PAGES = ['home', 'ayuda', 'desap', 'ninos', 'grupos', 'refugios', 'panel', 'bot', 'info', 'salvo'];

function timingSafeEqual(a: string, b: string): boolean {
  const e = new TextEncoder(); const ab = e.encode(a), bb = e.encode(b);
  let d = ab.length ^ bb.length; for (let i = 0; i < bb.length; i++) d |= (ab[i] ?? 0) ^ bb[i]; return d === 0;
}
function sbH() { return { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, Prefer: 'count=exact', Range: '0-0' }; }
async function count(q: string): Promise<number> {
  try { const r = await fetch(`${SB}/rest/v1/analytics_events?${q}`, { method: 'HEAD', headers: sbH() }); return parseInt((r.headers.get('content-range') || '').split('/')[1] || '0', 10) || 0; } catch { return 0; }
}

export default async function handler(req: Request): Promise<Response> {
  if (!SB || !SERVICE || !ADMIN_KEY) return json({ error: 'misconfigured' }, 503);
  const key = (() => { try { return new URL(req.url).searchParams.get('key') || ''; } catch { return ''; } })();
  if (!timingSafeEqual(key, ADMIN_KEY)) return json({ error: 'forbidden' }, 403);

  // "hoy" = desde la medianoche en Caracas (UTC-4), expresada en UTC (00:00 Caracas = 04:00Z).
  const today = new Date(Date.now() - 4 * 3600 * 1000).toISOString().slice(0, 10) + 'T04:00:00Z';
  const [visitantes, vistas, vistas_hoy, visit_hoy, busquedas, reportes, bot] = await Promise.all([
    count('ev=eq.visit&select=id'),
    count('ev=eq.view&select=id'),
    count(`ev=eq.view&ts=gte.${encodeURIComponent(today)}&select=id`),
    count(`ev=eq.visit&ts=gte.${encodeURIComponent(today)}&select=id`),
    count('ev=eq.search&select=id'),
    count('ev=eq.report&select=id'),
    count('ev=eq.bot&select=id'),
  ]);
  const por_pagina: Record<string, number> = {};
  await Promise.all(PAGES.map(async p => { por_pagina[p] = await count(`ev=eq.view&page=eq.${p}&select=id`); }));

  // Origen de las visitas: fuente (referente) + país + ciudad (agregado en JS sobre ev=visit)
  const por_fuente: Record<string, number> = {}, por_pais: Record<string, number> = {}, por_ciudad: Record<string, number> = {};
  try {
    const rows = await fetch(`${SB}/rest/v1/analytics_events?ev=eq.visit&select=ref,pais,ciudad&order=ts.desc&limit=20000`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } }).then(r => r.ok ? r.json() : []);
    for (const r of (Array.isArray(rows) ? rows : [])) {
      const f = r.ref || 'directo'; por_fuente[f] = (por_fuente[f] || 0) + 1;
      if (r.pais) por_pais[r.pais] = (por_pais[r.pais] || 0) + 1;
      if (r.ciudad) por_ciudad[r.ciudad] = (por_ciudad[r.ciudad] || 0) + 1;
    }
  } catch { /* sin datos de origen */ }

  return json({
    visitantes_unicos: visitantes, visitantes_hoy: visit_hoy,
    vistas, vistas_hoy,
    interacciones: { busquedas, reportes, bot },
    por_pagina, por_fuente, por_pais, por_ciudad,
    generado: new Date().toISOString(),
  });
}
function json(b: unknown, s = 200): Response {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
}
