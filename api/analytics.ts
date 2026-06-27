/**
 * SismoVE · Panel de analítica (solo admin). GET ?key=ADMIN_KEY.
 * Lee analytics_events con service_role y devuelve conteos agregados (sin PII).
 */
export const config = { runtime: 'edge' };

const SB = process.env.SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ADMIN_KEY = process.env.ADMIN_KEY;
const PAGES = ['home', 'ayuda', 'desap', 'ninos', 'refugios', 'panel', 'bot', 'info', 'salvo'];

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

  const today = new Date().toISOString().slice(0, 10) + 'T00:00:00Z';
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

  return json({
    visitantes_unicos: visitantes, visitantes_hoy: visit_hoy,
    vistas, vistas_hoy,
    interacciones: { busquedas, reportes, bot },
    por_pagina,
    generado: new Date().toISOString(),
  });
}
function json(b: unknown, s = 200): Response {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
}
