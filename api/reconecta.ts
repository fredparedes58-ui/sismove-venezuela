/**
 * SismoVE · Proxy de Reconecta Venezuela (puntos de internet/WiFi gratis · Starlink).
 *
 * reconectavenezuela.com publica /data/sites.json (público) pero exige cabecera Referer
 * (anti-hotlink) y no expone CORS, así que el cliente no puede leerlo directo. Este
 * endpoint lo trae server-side con Referer + User-Agent, lo normaliza y lo sirve a la app
 * (CORS *), cacheado en el CDN. Datos en vivo de la iniciativa; atribución visible en la app.
 * NO se salta CAPTCHA ni protección: solo se reenvía un JSON público con su propio Referer.
 */
export const config = { runtime: 'edge' };

const SRC = 'https://www.reconectavenezuela.com/data/sites.json';

export default async function handler(): Promise<Response> {
  try {
    const r = await fetch(SRC, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SismoVE/1.0; +https://sismove-venezuela.vercel.app)',
        'Referer': 'https://www.reconectavenezuela.com/',
        'Origin': 'https://www.reconectavenezuela.com',
        'Accept': 'application/json, text/plain, */*',
      },
    });
    if (!r.ok) return json({ error: 'upstream', status: r.status, sites: [] }, 502);
    const d: any = await r.json();
    const sites = (Array.isArray(d?.sites) ? d.sites : [])
      .map((s: any) => ({
        name: s?.name ?? null,
        region: s?.region ?? null,
        address: s?.address ?? null,
        lat: typeof s?.lat === 'number' ? s.lat : null,
        lng: typeof s?.lng === 'number' ? s.lng : null,
        status: s?.status ?? null,            // ok | busy | full | offline
        online: !!s?.online,
        users: typeof s?.users === 'number' ? s.users : null,
      }))
      .filter((s: any) => typeof s.lat === 'number' && typeof s.lng === 'number');
    return json(
      { updatedAt: d?.updatedAt ?? null, count: sites.length, sites },
      200,
      'public, s-maxage=180, stale-while-revalidate=600, stale-if-error=86400',
    );
  } catch (e: any) {
    return json({ error: 'fetch_failed', detail: e?.message, sites: [] }, 502);
  }
}

function json(b: unknown, s = 200, cache = 'no-store'): Response {
  return new Response(JSON.stringify(b), {
    status: s,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': cache },
  });
}
