/**
 * SismoVE · Reporte de persona (desaparecida / rescatada) con DEDUP.
 *
 * POST { nombre, edad, cedula, zona, direccion, visto, contacto, nota, foto_url, estado, categoria }
 *  - estado='buscando'   → inserta como desaparecido.
 *  - estado='encontrado' → si YA existe un desaparecido (mismo nombre normalizado, misma categoría)
 *    con estado='buscando', lo PROMUEVE a 'encontrado' (actualiza en sitio, rellena campos) en vez
 *    de crear una segunda fila → así no queda en ambos cuadros. Si no existe, lo inserta.
 *
 * Usa service_role (anon no tiene policy de UPDATE). La cédula entra por reporte MANUAL del familiar.
 */
export const config = { runtime: 'edge' };

const SB = process.env.SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const TBL = 'desaparecidos_reportes';

function sbH(extra: Record<string, string> = {}) {
  return { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...extra };
}
const norm = (s: any) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const s = (v: any, n: number) => { const t = String(v || '').trim().slice(0, n); return t || null; };

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  if (!SB || !SERVICE) return json({ error: 'misconfigured' }, 503);
  let b: any; try { b = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const nombre = String(b?.nombre || '').trim();
  if (nombre.length < 3) return json({ error: 'nombre' }, 400);
  const categoria = b?.categoria === 'nino' ? 'nino' : null;
  const estado = b?.estado === 'encontrado' ? 'encontrado' : 'buscando';
  const rec: any = {
    nombre, edad: s(b.edad, 20), cedula: s(b.cedula, 20), zona: s(b.zona, 80),
    direccion: s(b.direccion, 160), visto: s(b.visto, 160), contacto: s(b.contacto, 40),
    nota: s(b.nota, 200), foto_url: b?.foto_url || null, estado, categoria,
  };
  // columnas nuevas: solo se incluyen si traen valor (no rompe si aún falta el SQL)
  const ep = s(b.encontrado_por, 80); if (ep) rec.encontrado_por = ep;
  const du = b?.documento_url || null; if (du) rec.documento_url = du;

  try {
    if (estado === 'encontrado') {
      // ¿ya está como desaparecido (buscando)? → promover, no duplicar
      const catF = categoria ? 'categoria=eq.nino' : 'categoria=is.null';
      const tok = norm(nombre).split(' ')[0] || norm(nombre);
      const cands = await fetch(`${SB}/rest/v1/${TBL}?select=id,nombre&estado=eq.buscando&${catF}&nombre=ilike.${encodeURIComponent('*' + tok + '*')}&limit=300`, { headers: sbH() }).then(r => r.json()).catch(() => []);
      const ids = (Array.isArray(cands) ? cands : []).filter((c: any) => norm(c.nombre) === norm(nombre)).map((c: any) => c.id);
      if (ids.length) {
        const patch: any = { estado: 'encontrado' };
        for (const k of ['edad', 'cedula', 'zona', 'direccion', 'visto', 'contacto', 'encontrado_por', 'nota', 'foto_url', 'documento_url']) if (rec[k]) patch[k] = rec[k];
        const r = await fetch(`${SB}/rest/v1/${TBL}?id=in.(${ids.join(',')})`, { method: 'PATCH', headers: sbH({ Prefer: 'return=minimal' }), body: JSON.stringify(patch) });
        if (!r.ok) return json({ error: 'db', detail: (await r.text()).slice(0, 140) }, 502);
        return json({ accion: 'promovido', movidos: ids.length });
      }
    }
    const r = await fetch(`${SB}/rest/v1/${TBL}`, { method: 'POST', headers: sbH({ Prefer: 'return=minimal' }), body: JSON.stringify([rec]) });
    if (!r.ok) return json({ error: 'db', detail: (await r.text()).slice(0, 140) }, 502);
    return json({ accion: 'insertado' });
  } catch (e: any) {
    return json({ error: 'fail', detail: e?.message }, 500);
  }
}
function json(b: unknown, st = 200): Response {
  return new Response(JSON.stringify(b), { status: st, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
}
