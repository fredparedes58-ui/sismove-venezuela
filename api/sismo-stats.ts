/**
 * SismoVE · Cifras oficiales del terremoto para el banner rojo.
 *
 * Fuente: artículo de Wikipedia (es) "Terremotos de Venezuela de 2026" — el agregador
 * más neutral, citado y actualizado (cita ONU / Asamblea Nacional / gobierno). Gemini
 * EXTRAE las cifras del texto (robusto a cambios de formato); NO inventa (solo lee el texto).
 *
 * GET (sin key)            → devuelve lo último guardado (lo consume el banner).
 * GET ?key=SECRET&refresh=1 → relee Wikipedia, extrae y guarda (lo llama el cron; throttle).
 *
 * Requiere tabla `sismo_stats` (supabase/schema_stats.sql) y GEMINI_API_KEY.
 */
export const config = { runtime: 'edge' };

const SB = process.env.SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SECRET = process.env.SCRAPER_WEBHOOK_SECRET;
const GEMINI = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const WIKI_URL = 'https://es.wikipedia.org/wiki/Terremotos_de_Venezuela_de_2026';
const WIKI_API = 'https://es.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&exintro=1&redirects=1&format=json&titles=' + encodeURIComponent('Terremotos de Venezuela de 2026');
const REFRESH_MIN = 30;

const sbH = (e: Record<string, string> = {}) => ({ apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...e });

async function latest(): Promise<any | null> {
  try {
    const r = await fetch(`${SB}/rest/v1/sismo_stats?select=*&order=updated_at.desc&limit=1`, { headers: sbH() }).then(x => x.json());
    return Array.isArray(r) && r[0] ? r[0] : null;
  } catch { return null; }
}

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const refresh = url.searchParams.get('refresh');
  const force = !!url.searchParams.get('key') && url.searchParams.get('key') === SECRET;

  // Banner: devuelve lo último guardado (público, cacheable)
  if (!refresh || !force) {
    return json({ stats: await latest(), fuente_url: WIKI_URL }, 200, true);
  }

  // Refresh (cron): throttle
  const cur = await latest();
  if (cur && Date.now() - new Date(cur.updated_at).getTime() < REFRESH_MIN * 60000)
    return json({ status: 'cached', stats: cur });
  if (!GEMINI) return json({ status: 'no_gemini', stats: cur });

  // 1) Texto de Wikipedia (intro en texto plano)
  let texto = '';
  try {
    const w = await fetch(WIKI_API, { headers: { 'User-Agent': 'SismoVE/1.0 (respuesta sismica; contacto pedro.paredes@kenmei.ai)' } }).then(r => r.json());
    const pages = (w && w.query && w.query.pages) || {};
    texto = (Object.values(pages)[0] as any)?.extract || '';
  } catch { /* sin red a Wikipedia */ }
  if (!texto) return json({ status: 'sin_fuente', stats: cur });

  // 2) Gemini extrae cifras SOLO del texto de Wikipedia
  let stats: any = null;
  try {
    const prompt = `Del siguiente texto de Wikipedia sobre el terremoto de Venezuela de junio 2026, extrae las cifras OFICIALES MÁS RECIENTES de víctimas. Devuelve SOLO JSON válido:\n{"fallecidos":<entero|null>,"heridos":<entero|null>,"desaparecidos":<entero|null>,"afectados":<entero|null>,"fecha":"<la fecha de actualización tal como aparezca>","fuente":"<quién reporta la cifra: Asamblea Nacional / ONU / gobierno / etc>"}\nReglas: números ENTEROS sin puntos de miles (4.300 → 4300; 6,76 millones → 6760000). Si un dato no aparece, usa null. NO inventes nada que no esté en el texto.\n\nTEXTO:\n${texto.slice(0, 4500)}`;
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { response_mime_type: 'application/json', temperature: 0 } }),
    });
    const j: any = await res.json();
    stats = JSON.parse(j?.candidates?.[0]?.content?.parts?.[0]?.text || 'null');
  } catch { /* fallo de extracción */ }
  if (!stats || (stats.fallecidos == null && stats.heridos == null)) return json({ status: 'sin_extraccion', stats: cur });

  // 3) Guardar (si la tabla existe; si no, igual devuelve la cifra fresca)
  const num = (v: any) => (typeof v === 'number' && isFinite(v) ? Math.round(v) : null);
  const row = {
    fallecidos: num(stats.fallecidos), heridos: num(stats.heridos),
    desaparecidos: num(stats.desaparecidos), afectados: num(stats.afectados),
    fecha: String(stats.fecha || '').slice(0, 60), fuente: String(stats.fuente || '').slice(0, 140),
    url: WIKI_URL, updated_at: new Date().toISOString(),
  };
  await fetch(`${SB}/rest/v1/sismo_stats`, { method: 'POST', headers: sbH({ Prefer: 'return=minimal' }), body: JSON.stringify([row]) }).catch(() => {});
  return json({ status: 'actualizado', stats: row });
}

function json(b: unknown, s = 200, pub = false): Response {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': pub ? 'public, max-age=300' : 'no-store' } });
}
