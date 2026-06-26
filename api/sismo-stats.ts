/**
 * SismoVE · Cifras del terremoto por FUENTE para el banner rojo.
 *
 * Scrapea 3 páginas indicadas por el usuario y Gemini extrae de cada una las cifras
 * (muertes, desaparecidos, aparecidos, rescatados, heridos). Guarda un array por fuente
 * → el banner muestra cada cifra ETIQUETADA con la página de la que viene. NO inventa:
 * Gemini solo lee el texto de cada página; si una no trae el dato, queda null.
 *
 * GET (sin key)             → último guardado (lo consume el banner).
 * GET ?key=SECRET&refresh=1 → relee las 3 páginas y guarda (lo llama el cron; throttle).
 *
 * Requiere tabla `sismo_stats` (supabase/schema_stats.sql) y GEMINI_API_KEY.
 */
export const config = { runtime: 'edge' };

const SB = process.env.SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SECRET = process.env.SCRAPER_WEBHOOK_SECRET;
const GEMINI = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const REFRESH_MIN = 60;   // scrapea cada página 1 vez por hora (resto de llamadas del cron = cache)

const FUENTES: { nombre: string; url: string; api?: string }[] = [
  { nombre: 'Vozpópuli', url: 'https://www.vozpopuli.com/internacional/terremotos-en-venezuela-en-directo-ultima-hora-del-desastre-numero-de-fallecidos-y-total-de-desaparecidos-espanoles.html' },
  { nombre: 'OKDIARIO', url: 'https://okdiario.com/internacional/ultima-hora-del-terremoto-venezuela-directo-muertos-heridos-desaparecidos-18863740' },
  { nombre: 'Afectados por el Terremoto', url: 'https://www.afectadosporelterremotovenezuela.com/' },
  { nombre: 'Wikipedia (cita Asamblea Nacional/ONU)', url: 'https://es.wikipedia.org/wiki/Terremotos_de_Venezuela_de_2026', api: 'https://es.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&exintro=1&redirects=1&format=json&titles=' + encodeURIComponent('Terremotos de Venezuela de 2026') },
];

const sbH = (e: Record<string, string> = {}) => ({ apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...e });

async function latest(): Promise<any | null> {
  try {
    const r = await fetch(`${SB}/rest/v1/sismo_stats?select=*&order=updated_at.desc&limit=1`, { headers: sbH() }).then(x => x.json());
    const row = Array.isArray(r) && r[0] ? r[0] : null;
    // Usa la columna `sources` (jsonb) si tiene datos; si no, cae al respaldo en `fuente` (rows viejas).
    if (row && (!Array.isArray(row.sources) || row.sources.length === 0) && typeof row.fuente === 'string' && row.fuente.trim().startsWith('[')) {
      try { row.sources = JSON.parse(row.fuente); } catch {}
    }
    return row;
  } catch { return null; }
}

const numOrNull = (v: any) => (typeof v === 'number' && isFinite(v) ? Math.round(v) : null);

async function extraer(f: { nombre: string; url: string; api?: string }) {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
  let limpio = '';
  try {
    if (f.api) {
      const w: any = await fetch(f.api, { headers: { 'User-Agent': UA } }).then(r => r.json());
      const pages = (w && w.query && w.query.pages) || {};
      limpio = ((Object.values(pages)[0] as any)?.extract || '').replace(/\s+/g, ' ').trim();
    } else {
      const html = await (await fetch(f.url, { headers: { 'User-Agent': UA, 'Accept-Language': 'es-ES,es;q=0.9' } })).text();
      limpio = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 150000);
    }
  } catch { return { nombre: f.nombre, url: f.url, error: 'sin_html' }; }
  if (!limpio || limpio.length < 40) return { nombre: f.nombre, url: f.url, error: 'sin_texto' };
  if (!GEMINI) return { nombre: f.nombre, url: f.url, error: 'no_gemini' };
  // Ancla la ventana donde hay NÚMERO junto a palabra de víctima (ahí está la cifra real);
  // si no, en la primera mención. Una sola ventana ancha funciona mejor que muchas cortas.
  const low = limpio.toLowerCase();
  const k = low.search(/fallecid|muert[oa]s|v[ií]ctimas|desaparecid/);
  const frag = k >= 0 ? limpio.slice(Math.max(0, k - 1500), k + 7000) : limpio.slice(0, 7000);
  try {
    const prompt = `Texto de la página "${f.nombre}" sobre el terremoto de Venezuela de junio 2026. Extrae las cifras MÁS RECIENTES de víctimas que aparezcan en el texto. Devuelve SOLO JSON válido:\n{"fallecidos":<entero|null>,"heridos":<entero|null>,"desaparecidos":<entero|null>,"rescatados":<entero|null>,"aparecidos":<entero|null>,"fecha":"<fecha/hora de actualización si aparece>"}\n"aparecidos" = personas dadas por encontradas/localizadas con vida. Números ENTEROS sin separador de miles (4.300→4300; 6,76 millones→6760000). Si un dato NO está en el texto, usa null. NO inventes.\n\nTEXTO:\n${frag}`;
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { response_mime_type: 'application/json', temperature: 0 } }),
    });
    const j: any = await res.json();
    const p = JSON.parse(j?.candidates?.[0]?.content?.parts?.[0]?.text || '{}');
    return {
      nombre: f.nombre, url: f.url,
      fallecidos: numOrNull(p.fallecidos), heridos: numOrNull(p.heridos),
      desaparecidos: numOrNull(p.desaparecidos), rescatados: numOrNull(p.rescatados),
      aparecidos: numOrNull(p.aparecidos), fecha: String(p.fecha || '').slice(0, 60),
    };
  } catch { return { nombre: f.nombre, url: f.url, error: 'sin_extraccion' }; }
}

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const refresh = url.searchParams.get('refresh');
  const force = !!url.searchParams.get('key') && url.searchParams.get('key') === SECRET;

  if (!refresh || !force) return json({ stats: await latest() }, 200, true);

  const cur = await latest();
  if (cur && Date.now() - new Date(cur.updated_at).getTime() < REFRESH_MIN * 60000)
    return json({ status: 'cached', stats: cur });

  // Scrapea las 3 fuentes (secuencial: evita ráfaga a Gemini)
  const sources: any[] = [];
  for (const f of FUENTES) sources.push(await extraer(f));

  const conDatos = sources.filter(s => s.fallecidos != null || s.desaparecidos != null || s.rescatados != null || s.heridos != null);
  if (!conDatos.length) return json({ status: 'sin_datos', stats: cur, debug: sources });

  // Guarda en la tabla EXISTENTE (formato plano): el array de fuentes va como JSON en `fuente`;
  // las columnas planas se rellenan con la cifra más alta por compatibilidad. (Sin SQL nuevo.)
  const top = (k: string) => { const a = sources.filter((s: any) => s[k] != null).sort((x: any, y: any) => y[k] - x[k]); return a[0] ? a[0][k] : null; };
  const now = new Date().toISOString();
  const dbRow = { sources, fallecidos: top('fallecidos'), heridos: top('heridos'), desaparecidos: top('desaparecidos'), fuente: JSON.stringify(sources), url: 'multi-fuente', updated_at: now };
  await fetch(`${SB}/rest/v1/sismo_stats`, { method: 'POST', headers: sbH({ Prefer: 'return=minimal' }), body: JSON.stringify([dbRow]) }).catch(() => {});
  return json({ status: 'actualizado', stats: { sources, updated_at: now } });
}

function json(b: unknown, s = 200, pub = false): Response {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': pub ? 'public, max-age=180' : 'no-store' } });
}
