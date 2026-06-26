/**
 * SismoVE · Aviso a suscriptores de Telegram cuando hay DATOS NUEVOS.
 *
 * Lo llama el cron en cada corrida (?key=SCRAPER_WEBHOOK_SECRET). Compara el conteo
 * actual de cada tabla con el último guardado en `sync_runs` (source='notify:*').
 * Si algo creció, envía un resumen a todos los `bot_subscribers` activos y actualiza
 * la línea base. En la PRIMERA corrida solo fija la base (no manda nada → evita ruido).
 */
export const config = { runtime: 'edge' };

const SB = process.env.SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SECRET = process.env.SCRAPER_WEBHOOK_SECRET;
const APP = 'https://sismove-venezuela.vercel.app/app';

const SOURCES = [
  { key: 'notify:hosp',    table: 'hospital_admisiones',     label: '🏥 ingresos hospitalarios' },
  { key: 'notify:desap',   table: 'desaparecidos_external',  label: '🔍 personas reportadas' },
  { key: 'notify:centros', table: 'centros_acopio_external', label: '📦 centros de acopio' },
  { key: 'notify:zonas',   table: 'zona_reports',            label: '⚠️ zonas afectadas reportadas' },
];

function sbH(extra: Record<string, string> = {}) {
  return { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...extra };
}
async function count(table: string): Promise<number> {
  const r = await fetch(`${SB}/rest/v1/${table}?select=id`, { headers: sbH({ Prefer: 'count=exact', Range: '0-0' }) });
  return parseInt((r.headers.get('content-range') || '').split('/')[1] || '0', 10);
}
async function lastCount(key: string): Promise<number | null> {
  const r = await fetch(`${SB}/rest/v1/sync_runs?source=eq.${encodeURIComponent(key)}&order=ran_at.desc&limit=1`, { headers: sbH() })
    .then(x => x.json()).catch(() => []);
  return Array.isArray(r) && r[0] && typeof r[0].count === 'number' ? r[0].count : null;
}
async function record(key: string, c: number) {
  await fetch(`${SB}/rest/v1/sync_runs`, { method: 'POST', headers: sbH({ Prefer: 'return=minimal' }), body: JSON.stringify([{ source: key, ok: true, count: c }]) }).catch(() => {});
}
async function activeSubscribers(): Promise<string[]> {
  const r = await fetch(`${SB}/rest/v1/bot_subscribers?select=chat_id&unsubscribed_at=is.null`, { headers: sbH() })
    .then(x => x.json()).catch(() => []);
  return Array.isArray(r) ? r.map((x: any) => String(x.chat_id)).filter(Boolean) : [];
}

export default async function handler(req: Request): Promise<Response> {
  if (!SB || !SERVICE) return json({ error: 'no_supabase' }, 503);
  const key = (() => { try { return new URL(req.url).searchParams.get('key'); } catch { return null; } })();
  if (!SECRET || key !== SECRET) return json({ error: 'forbidden' }, 403);

  const deltas: { label: string; add: number; total: number }[] = [];
  for (const s of SOURCES) {
    const cur = await count(s.table);
    const prev = await lastCount(s.key);
    if (prev !== null && cur > prev) deltas.push({ label: s.label, add: cur - prev, total: cur });
    await record(s.key, cur);                       // siempre actualiza la línea base
  }
  if (!deltas.length) return json({ status: 'sin_cambios' });
  if (!TOKEN) return json({ status: 'deltas_sin_bot', deltas });

  const subs = await activeSubscribers();
  if (!subs.length) return json({ status: 'sin_suscriptores', deltas });

  const lines = deltas.map(d => `• ${d.label}: +${d.add} (total ${d.total})`).join('\n');
  const text = `🔔 SismoVE — información actualizada:\n${lines}\n\nBuscar / ver mapas: ${APP}`;
  let sent = 0;
  for (const chat of subs) {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    });
    if (r.ok) sent++; else if (r.status === 403) await fetch(`${SB}/rest/v1/bot_subscribers?chat_id=eq.${chat}`, { method: 'PATCH', headers: sbH({ Prefer: 'return=minimal' }), body: JSON.stringify({ unsubscribed_at: new Date().toISOString() }) }).catch(() => {});
  }
  return json({ status: 'notificado', deltas, subscribers: subs.length, sent });
}
function json(b: unknown, s = 200): Response {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
