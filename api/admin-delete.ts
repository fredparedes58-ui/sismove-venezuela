/**
 * SismoVE · Borrado de reportes comunitarios (solo admin).
 *
 * POST { table, id, key }. Verifica `key` contra ADMIN_KEY (env, no en el cliente).
 * Borra una fila de una tabla EN LISTA BLANCA usando service_role (que ignora RLS).
 * Las tablas comunitarias tienen RLS sin policy de DELETE → la anon NO puede borrar;
 * solo este endpoint (con la clave correcta) puede.
 */
export const config = { runtime: 'edge' };

const SB = process.env.SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ADMIN_KEY = process.env.ADMIN_KEY;
const TABLES = new Set(['logistica_reports', 'zona_reports', 'coverage_reports', 'power_reports', 'desaparecidos_reportes']);

function timingSafeEqual(a: string, b: string): boolean {
  const e = new TextEncoder(); const ab = e.encode(a), bb = e.encode(b);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < bb.length; i++) diff |= (ab[i] ?? 0) ^ bb[i];
  return diff === 0;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  if (!ADMIN_KEY || !SB || !SERVICE) return json({ error: 'misconfigured' }, 503);
  let b: any; try { b = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }
  if (!b?.key || !timingSafeEqual(String(b.key), ADMIN_KEY)) return json({ error: 'forbidden' }, 403);
  if (!TABLES.has(b.table) || !b.id) return json({ error: 'bad_params' }, 400);

  const r = await fetch(`${SB}/rest/v1/${b.table}?id=eq.${encodeURIComponent(b.id)}`, {
    method: 'DELETE',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, Prefer: 'return=minimal' },
  });
  return r.ok ? json({ ok: true }) : json({ error: 'db', status: r.status }, 502);
}

function json(b: unknown, s = 200): Response {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
}
