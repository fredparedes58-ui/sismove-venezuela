/**
 * SismoVE · Torres EN VIVO por zona (proxy de OpenCelliD getInArea) — Edge Runtime
 *
 * El dashboard, con zoom en un barrio, llama GET /api/towers/live?bbox=latmin,lonmin,latmax,lonmax
 * Aquí se consulta OpenCelliD con la API key SERVER-SIDE (nunca se expone al navegador).
 * El free tier limita el BBOX a 4.000.000 m² (~2×2 km): validamos antes de llamar.
 */
export const config = { runtime: 'edge' };

const KEY = process.env.OPENCELLID_API_KEY;
const MNC: Record<string, string> = { '01': 'Digitel', '02': 'Movilnet', '03': 'Digitel', '04': 'Movistar', '06': 'Movistar' };

export default async function handler(req: Request): Promise<Response> {
  const u = new URL(req.url);
  const bbox = u.searchParams.get('bbox');
  if (!bbox) return json({ error: 'missing_bbox', hint: 'bbox=latmin,lonmin,latmax,lonmax' }, 400);
  if (!KEY) return json({ error: 'no_key', hint: 'Falta OPENCELLID_API_KEY en el servidor' }, 503);

  const [la1, lo1, la2, lo2] = bbox.split(',').map(Number);
  if ([la1, lo1, la2, lo2].some(n => !isFinite(n))) return json({ error: 'bad_bbox' }, 400);

  // Área aproximada en km² (límite free tier ≈ 4)
  const km2 = (Math.abs(la2 - la1) * 111) * (Math.abs(lo2 - lo1) * 111 * Math.cos(((la1 + la2) / 2) * Math.PI / 180));
  if (km2 > 4.2) return json({ error: 'bbox_too_big', km2: Math.round(km2), hint: 'Acerca el zoom (máx ~2×2 km en el plan gratuito)' }, 422);

  try {
    const url = `https://opencellid.org/cell/getInArea?key=${KEY}&BBOX=${la1},${lo1},${la2},${lo2}&mcc=734&format=json&limit=1000`;
    const r = await fetch(url);
    const j: any = await r.json();
    if (j.error) return json({ error: 'opencellid', detail: j.error }, 502);
    const towers = (j.cells || []).map((c: any) => ({
      lat: c.lat, lng: c.lon,
      operador: MNC[String(c.mnc).padStart(2, '0')] || `734-${c.mnc}`,
      radio: c.radio || null, range: c.range || null, samples: c.samples || 0,
    }));
    return json({ towers, count: towers.length, source: 'opencellid-live' }, 200);
  } catch (e: any) {
    return json({ error: 'fetch_failed', detail: e.message }, 502);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=300' },
  });
}
