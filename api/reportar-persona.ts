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
    nota: s(b.nota, 400), foto_url: b?.foto_url || null, estado, categoria,
  };
  // columnas nuevas: solo se incluyen si traen valor. Si la columna aún no existe en
  // la BD, el insert/patch reintenta SIN ellas (stripNew) para no fallar del todo.
  const ep = s(b.encontrado_por, 80); if (ep) rec.encontrado_por = ep;
  const du = b?.documento_url || null; if (du) rec.documento_url = du;
  rec.tipo_persona = b?.tipo_persona === 'nino' ? 'nino' : b?.tipo_persona === 'adulto' ? 'adulto' : (categoria === 'nino' ? 'nino' : 'adulto');
  const rf = s(b.referencia, 100); if (rf) rec.referencia = rf;
  const fotos = Array.isArray(b?.fotos) ? b.fotos.filter((u: any) => typeof u === 'string' && /^https:\/\//.test(u)).slice(0, 8) : null;
  if (fotos && fotos.length) rec.fotos = fotos;
  const lat = Number(b?.lat), lng = Number(b?.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) { rec.lat = lat; rec.lng = lng; }

  try {
    if (estado === 'encontrado') {
      // ¿ya está como desaparecido (buscando)? → promover, no duplicar
      const catF = categoria ? 'categoria=eq.nino' : 'categoria=is.null';
      const tok = norm(nombre).split(' ')[0] || norm(nombre);
      const cands = await fetch(`${SB}/rest/v1/${TBL}?select=id,nombre&estado=eq.buscando&${catF}&nombre=ilike.${encodeURIComponent('*' + tok + '*')}&limit=300`, { headers: sbH() }).then(r => r.json()).catch(() => []);
      const ids = (Array.isArray(cands) ? cands : []).filter((c: any) => norm(c.nombre) === norm(nombre)).map((c: any) => c.id);
      if (ids.length) {
        const patch: any = { estado: 'encontrado' };
        for (const k of ['edad', 'cedula', 'zona', 'direccion', 'referencia', 'visto', 'contacto', 'encontrado_por', 'nota', 'foto_url', 'fotos', 'documento_url', 'tipo_persona', 'lat', 'lng']) if (rec[k] != null) patch[k] = rec[k];
        const r = await write(`${TBL}?id=in.(${ids.join(',')})`, 'PATCH', patch);
        if (!r.ok) return json({ error: 'db', detail: r.detail }, 502);
        return json({ accion: 'promovido', movidos: ids.length });
      }
    }
    const r = await write(TBL, 'POST', [rec]);
    if (!r.ok) return json({ error: 'db', detail: r.detail }, 502);
    return json({ accion: 'insertado' });
  } catch (e: any) {
    return json({ error: 'fail', detail: e?.message }, 500);
  }
}

// Columnas que pueden no existir aún (antes de la migración). Si la BD se queja de
// una columna desconocida, reintenta una vez sin estas claves.
const NEW_COLS = ['tipo_persona', 'referencia', 'fotos', 'lat', 'lng', 'encontrado_por', 'documento_url'];
function stripNew(payload: any): any {
  const strip = (o: any) => { const c = { ...o }; for (const k of NEW_COLS) delete c[k]; return c; };
  return Array.isArray(payload) ? payload.map(strip) : strip(payload);
}
async function write(path: string, method: string, payload: any): Promise<{ ok: boolean; detail?: string }> {
  let r = await fetch(`${SB}/rest/v1/${path}`, { method, headers: sbH({ Prefer: 'return=minimal' }), body: JSON.stringify(payload) });
  if (r.ok) return { ok: true };
  const t = await r.text();
  if (/PGRST204|schema cache|column/i.test(t)) {
    r = await fetch(`${SB}/rest/v1/${path}`, { method, headers: sbH({ Prefer: 'return=minimal' }), body: JSON.stringify(stripNew(payload)) });
    if (r.ok) return { ok: true };
    return { ok: false, detail: (await r.text()).slice(0, 140) };
  }
  return { ok: false, detail: t.slice(0, 140) };
}
function json(b: unknown, st = 200): Response {
  return new Response(JSON.stringify(b), { status: st, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
}
