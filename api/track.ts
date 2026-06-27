/**
 * SismoVE · Registro de analítica anónima (visit/view/search/report/bot).
 *
 * El cliente envía { ev, page, session, ref } y este endpoint añade la UBICACIÓN
 * APROXIMADA leyéndola de las cabeceras de geo de Vercel (país/región/ciudad por IP
 * — NO es GPS ni dato personal) y CLASIFICA la fuente (referente) antes de insertar
 * con service_role. La IP NO se guarda; solo el país/región/ciudad agregables.
 */
export const config = { runtime: 'edge' };

const SB = process.env.SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const EVENTS = new Set(['visit', 'view', 'search', 'report', 'bot']);

const s = (v: any, n: number) => { const t = String(v ?? '').trim().slice(0, n); return t || null; };

// Clasifica el referente en una fuente legible; si es un host externo desconocido, guarda el host.
function classifyRef(ref: string): string {
  const r = (ref || '').toLowerCase();
  if (!r) return 'directo';
  if (/whatsapp|wa\.me/.test(r)) return 'whatsapp';
  if (/instagram/.test(r)) return 'instagram';
  if (/facebook|fb\.com|fb\.me|l\.facebook/.test(r)) return 'facebook';
  if (/t\.me|telegram/.test(r)) return 'telegram';
  if (/twitter|t\.co|x\.com/.test(r)) return 'twitter';
  if (/tiktok/.test(r)) return 'tiktok';
  if (/youtube|youtu\.be/.test(r)) return 'youtube';
  if (/google\./.test(r)) return 'google';
  if (/bing\./.test(r)) return 'bing';
  if (/sismove-venezuela\.vercel\.app|localhost|127\.0\.0\.1/.test(r)) return 'interno';
  try { const h = new URL(ref).hostname.replace(/^www\./, ''); return (h || 'otro').slice(0, 40); } catch { return 'otro'; }
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ ok: false }, 405);
  if (!SB || !SERVICE) return json({ ok: false }, 503);
  let b: any; try { b = await req.json(); } catch { return json({ ok: false }, 400); }

  const ev = String(b?.ev || '');
  if (!EVENTS.has(ev)) return json({ ok: false }, 400);   // solo eventos conocidos

  const h = req.headers;
  // Solo aceptar registros provenientes de nuestro propio dominio (corta el abuso cross-origin barato).
  const og = h.get('origin') || h.get('referer') || '';
  if (og) { try { const hn = new URL(og).hostname; if (hn !== 'sismove-venezuela.vercel.app' && !hn.startsWith('sismove-venezuela')) return json({ ok: false }, 403); } catch { return json({ ok: false }, 403); } }

  let ciudad: string | null = null;
  try { ciudad = decodeURIComponent(h.get('x-vercel-ip-city') || '') || null; } catch { ciudad = h.get('x-vercel-ip-city') || null; }

  const rec = {
    ev,
    page: s(b?.page, 24),
    session: s(b?.session, 40),
    ref: classifyRef(String(b?.ref || '')),
    pais: s(h.get('x-vercel-ip-country'), 4),
    region: s(h.get('x-vercel-ip-country-region'), 12),
    ciudad: ciudad ? ciudad.slice(0, 60) : null,
  };

  try {
    await fetch(`${SB}/rest/v1/analytics_events`, {
      method: 'POST',
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify([rec]),
    });
  } catch { /* registro best-effort */ }
  return json({ ok: true });
}

function json(b: unknown, st = 200): Response {
  return new Response(JSON.stringify(b), { status: st, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
}
