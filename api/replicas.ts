/**
 * SismoVE · Réplicas (sismos) — feed real de USGS, auto-actualizado a diario.
 *
 * Lee USGS FDSN (GeoJSON, gratis, sin key) acotado por radio al epicentro del doblete
 * (Yaracuy, 24-jun-2026). La respuesta se cachea en el CDN de Vercel 1 día
 * (s-maxage=86400) con stale-while-revalidate + stale-if-error → si USGS cae, se sigue
 * sirviendo el último dato bueno. La página de réplicas LEE de esta caché, no de USGS en vivo.
 * Fallback: si USGS falla, intenta EMSC (mismos parámetros FDSN).
 */
export const config = { runtime: 'edge' };

const EPI = { lat: 10.34, lng: -68.74 };   // epicentro principal (San Felipe / Yumare, Yaracuy)
const START = '2026-06-24';                // desde el sismo principal
const RADIUS_KM = 350;
const MINMAG = 2.5;

function distKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371, toR = (d: number) => d * Math.PI / 180;
  const dLat = toR(bLat - aLat), dLng = toR(bLng - aLng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toR(aLat)) * Math.cos(toR(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}
function fdsn(base: string): string {
  return `${base}?format=geojson&starttime=${START}&minmagnitude=${MINMAG}&latitude=${EPI.lat}&longitude=${EPI.lng}&maxradiuskm=${RADIUS_KM}&orderby=time&limit=300`;
}
async function fetchFeed(base: string): Promise<any[] | null> {
  try {
    const r = await fetch(fdsn(base), { headers: { 'User-Agent': 'SismoVE/1.0 (ayuda humanitaria; sismove-venezuela.vercel.app)', Accept: 'application/json' } });
    if (!r.ok) return null;
    const txt = await r.text(); if (!txt.trim().startsWith('{')) return null;
    const j = JSON.parse(txt);
    return (j.features || []).map((f: any) => {
      const c = f.geometry?.coordinates || [], p = f.properties || {};
      const lng = c[0], lat = c[1], depth = c[2];
      return {
        mag: typeof p.mag === 'number' ? Math.round(p.mag * 10) / 10 : null,
        lugar: p.place || 'Cerca del epicentro',
        time: p.time || null,
        depth: typeof depth === 'number' ? Math.round(depth) : null,
        dist: (typeof lat === 'number' && typeof lng === 'number') ? Math.round(distKm(EPI.lat, EPI.lng, lat, lng)) : null,
        url: p.url || null,
      };
    }).filter((q: any) => q.mag != null && q.time != null);
  } catch { return null; }
}

export default async function handler(): Promise<Response> {
  let sismos = await fetchFeed('https://earthquake.usgs.gov/fdsnws/event/1/query');
  let fuente = 'USGS';
  if (!sismos || !sismos.length) { const e = await fetchFeed('https://www.seismicportal.eu/fdsnws/event/1/query'); if (e && e.length) { sismos = e; fuente = 'EMSC'; } }
  if (!sismos) {
    // ambas fuentes fallaron → 503 sin cache: el CDN sirve el último dato bueno (stale-if-error)
    return json({ error: 'feed_unavailable' }, 503, 'no-store');
  }
  sismos.sort((a, b) => (b.time || 0) - (a.time || 0));
  const body = { generado: new Date().toISOString(), fuente, epicentro: EPI, radio_km: RADIUS_KM, count: sismos.length, sismos };
  return json(body, 200, 'public, s-maxage=86400, stale-while-revalidate=604800, stale-if-error=604800');
}
function json(b: unknown, s = 200, cache = 'no-store'): Response {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': cache } });
}
