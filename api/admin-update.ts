/**
 * SismoVE · Edición de reportes por el ADMIN (modificar, no solo borrar).
 *
 * POST { table, id, key, fields }. Verifica `key` contra ADMIN_KEY. Solo aplica las
 * columnas EN LISTA BLANCA por tabla (no deja tocar id/source/ext_id/created_at).
 * Usa service_role (las tablas comunitarias no tienen policy de UPDATE para anon).
 */
export const config = { runtime: 'edge' };

const SB = process.env.SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ADMIN_KEY = process.env.ADMIN_KEY;

const EDITABLE: Record<string, string[]> = {
  logistica_reports:     ['ciudad', 'tipo', 'estado', 'nota', 'direccion', 'descripcion', 'foto_url', 'lat', 'lng'],
  zona_reports:          ['ciudad', 'tipo', 'direccion', 'descripcion', 'foto_url', 'lat', 'lng'],
  coverage_reports:      ['ciudad', 'operador', 'estado', 'direccion', 'descripcion', 'foto_url', 'lat', 'lng'],
  power_reports:         ['ciudad', 'estado', 'direccion', 'descripcion', 'foto_url', 'lat', 'lng'],
  grupos_comunitarios:   ['nombre', 'tipo', 'zona', 'url', 'contacto', 'nota'],
  desaparecidos_reportes:['nombre', 'edad', 'cedula', 'zona', 'direccion', 'referencia', 'visto', 'contacto', 'encontrado_por', 'nota', 'estado', 'categoria', 'tipo_persona', 'foto_url', 'documento_url', 'lat', 'lng'],
};

function timingSafeEqual(a: string, b: string): boolean {
  const e = new TextEncoder(); const ab = e.encode(a), bb = e.encode(b);
  let d = ab.length ^ bb.length; for (let i = 0; i < bb.length; i++) d |= (ab[i] ?? 0) ^ bb[i]; return d === 0;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  if (!ADMIN_KEY || !SB || !SERVICE) return json({ error: 'misconfigured' }, 503);
  let b: any; try { b = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }
  if (!b?.key || !timingSafeEqual(String(b.key), ADMIN_KEY)) return json({ error: 'forbidden' }, 403);
  const allowed = EDITABLE[b?.table];
  if (!allowed || !b?.id) return json({ error: 'bad_params' }, 400);

  const patch: any = {};
  for (const k of allowed) {
    if (!(k in (b.fields || {}))) continue;
    let v = b.fields[k];
    if (v === '' || v === undefined) v = null;
    if (typeof v === 'string') v = v.slice(0, 400);
    if ((k === 'lat' || k === 'lng') && v != null) { const n = Number(v); v = Number.isFinite(n) ? n : null; }
    patch[k] = v;
  }
  if (!Object.keys(patch).length) return json({ error: 'nothing_to_update' }, 400);

  const r = await fetch(`${SB}/rest/v1/${b.table}?id=eq.${encodeURIComponent(b.id)}`, {
    method: 'PATCH',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
  return r.ok ? json({ ok: true }) : json({ error: 'db', detail: (await r.text()).slice(0, 160) }, 502);
}

function json(b: unknown, s = 200): Response {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
}
