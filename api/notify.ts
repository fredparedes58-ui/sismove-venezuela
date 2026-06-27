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
const HEARTBEAT_H = 6;   // aunque no haya novedades, confirma "revisado" como mucho cada 6 h

const SOURCES = [
  { key: 'notify:hosp',    table: 'hospital_admisiones',     label: '🏥 ingresos hospitalarios' },
  { key: 'notify:desap',   table: 'desaparecidos_external',  label: '🔍 personas reportadas' },
  { key: 'notify:centros', table: 'centros_acopio_external', label: '📦 centros de acopio' },
  { key: 'notify:zonas',   table: 'zona_reports',            label: '⚠️ zonas afectadas reportadas' },
  { key: 'notify:logi',    table: 'logistica_reports',       label: '🍲 necesidades / logística' },
  { key: 'notify:desaprep',table: 'desaparecidos_reportes',  label: '🔍 personas reportadas desaparecidas' },
];

function sbH(extra: Record<string, string> = {}) {
  return { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...extra };
}
async function count(table: string): Promise<number> {
  // HEAD + count=exact: cuenta sin depender de una columna concreta (las tablas _external
  // usan external_id, no id; pedir ?select=id daba error y devolvía 0).
  const r = await fetch(`${SB}/rest/v1/${table}`, { method: 'HEAD', headers: sbH({ Prefer: 'count=exact', Range: '0-0' }) });
  const n = parseInt((r.headers.get('content-range') || '').split('/')[1] || '', 10);
  return Number.isFinite(n) ? n : 0;
}
async function lastCount(key: string): Promise<number | null> {
  const r = await fetch(`${SB}/rest/v1/sync_runs?source=eq.${encodeURIComponent(key)}&order=ran_at.desc&limit=1`, { headers: sbH() })
    .then(x => x.json()).catch(() => []);
  return Array.isArray(r) && r[0] && typeof r[0].count === 'number' ? r[0].count : null;
}
async function record(key: string, c: number) {
  await fetch(`${SB}/rest/v1/sync_runs`, { method: 'POST', headers: sbH({ Prefer: 'return=minimal' }), body: JSON.stringify([{ source: key, ok: true, count: c }]) }).catch(() => {});
}
async function lastRanAt(key: string): Promise<number | null> {
  const r = await fetch(`${SB}/rest/v1/sync_runs?source=eq.${encodeURIComponent(key)}&order=ran_at.desc&limit=1`, { headers: sbH() }).then(x => x.json()).catch(() => []);
  return Array.isArray(r) && r[0]?.ran_at ? new Date(r[0].ran_at).getTime() : null;
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
  const totals: { label: string; total: number }[] = [];
  for (const s of SOURCES) {
    const cur = await count(s.table);
    const prev = await lastCount(s.key);
    if (cur >= 0) totals.push({ label: s.label, total: cur });
    if (prev !== null && cur > prev) deltas.push({ label: s.label, add: cur - prev, total: cur });
    await record(s.key, cur);                       // siempre actualiza la línea base
  }

  const subs = TOKEN ? await activeSubscribers() : [];
  if (!TOKEN || !subs.length) return json({ status: deltas.length ? 'deltas_sin_envio' : 'sin_cambios', deltas });

  let text: string | null = null, kind = 'sin_cambios';
  if (deltas.length) {
    text = `🔔 SismoVE — información actualizada:\n${deltas.map(d => `• ${d.label}: +${d.add} (total ${d.total})`).join('\n')}\n\nBuscar / ver mapas: ${APP}`;
    kind = 'notificado';
  } else {
    // Latido: "revisado, sin novedades" como mucho cada HEARTBEAT_H horas
    const lastHb = await lastRanAt('notify:heartbeat');
    if (!lastHb || Date.now() - lastHb > HEARTBEAT_H * 3600000) {
      text = `✅ SismoVE revisado — sin novedades por ahora.\n${totals.map(t => `• ${t.label}: ${t.total}`).join('\n')}\n\nTe aviso al instante si entra algo nuevo. Escribe /estado cuando quieras.`;
      kind = 'heartbeat';
    }
  }
  if (!text) return json({ status: 'sin_cambios' });

  let sent = 0;
  for (const chat of subs) {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    });
    if (r.ok) sent++; else if (r.status === 403) await fetch(`${SB}/rest/v1/bot_subscribers?chat_id=eq.${chat}`, { method: 'PATCH', headers: sbH({ Prefer: 'return=minimal' }), body: JSON.stringify({ unsubscribed_at: new Date().toISOString() }) }).catch(() => {});
  }
  if (kind === 'heartbeat') await record('notify:heartbeat', 1);   // marca el tiempo del último latido
  return json({ status: kind, deltas, subscribers: subs.length, sent });
}
function json(b: unknown, s = 200): Response {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
