/**
 * SismoVE · Webhook de ingesta del scraper  (patrón Krujens, Edge Runtime)
 *
 *  scraper → [HMAC X-Scraper-Signature] → este webhook → Supabase (_external)
 *          → detección de cambios → notification_queue
 *
 * Tipos aceptados: 'desaparecidos_sync' | 'centros_sync'
 * Escribe con SUPABASE_SERVICE_ROLE_KEY (server-side, bypasea RLS).
 */
export const config = { runtime: 'edge' };

type SyncType = 'desaparecidos_sync' | 'centros_sync';
interface Body { type: SyncType; source: string; timestamp: string; data: any[]; }

const SB = process.env.SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const rawBody = await req.text();

  // ─── Verificación HMAC ───────────────────────────────────────────────────
  const signature = req.headers.get('X-Scraper-Signature');
  const secret = process.env.SCRAPER_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('SCRAPER_WEBHOOK_SECRET no configurado — modo dev');
  } else {
    if (!signature) return json({ error: 'missing_signature' }, 401);
    if (!(await verifyHmac(rawBody, secret, signature))) return json({ error: 'invalid_signature' }, 401);
  }

  // ─── Parse + validación ────────────────────────────────────────────────────
  let body: Body;
  try { body = JSON.parse(rawBody); } catch { return json({ error: 'invalid_json' }, 400); }
  const valid: SyncType[] = ['desaparecidos_sync', 'centros_sync'];
  if (!valid.includes(body.type)) return json({ error: 'unknown_type', got: body.type }, 422);
  if (!Array.isArray(body.data)) return json({ error: 'data_must_be_array' }, 422);

  try {
    const result = body.type === 'desaparecidos_sync'
      ? await ingestDesaparecidos(body.data)
      : await ingestCentros(body.data);
    await logRun(body.source, true, body.data.length, null);
    return json({ status: 'ok', type: body.type, ...result }, 200, { 'X-Webhook-Version': '1.0' });
  } catch (e: any) {
    await logRun(body.source, false, body.data?.length ?? 0, e.message).catch(() => {});
    return json({ error: 'ingest_failed', detail: e.message }, 500);
  }
}

/* ─── Ingesta: desaparecidos ──────────────────────────────────────────────── */
async function ingestDesaparecidos(items: any[]) {
  // Estado previo para detectar transiciones a "encontrado"
  const prev = await sbSelect('desaparecidos_external', 'external_id,encontrado');
  const prevMap = new Map(prev.map((r: any) => [r.external_id, r.encontrado]));

  const rows = items.map(d => ({
    external_id: d.external_id, source: d.source, nombre: d.nombre,
    cedula: d.cedula ?? null, edad: d.edad ?? null, zona: d.zona ?? null,
    estado: d.estado ?? 'desaparecido', encontrado: !!d.encontrado,
    foto_url: d.foto_url ?? null, notas: d.notas ?? null,
    created_source: d.created_at ?? null, last_synced: new Date().toISOString(),
  }));

  const notifs: any[] = [];
  for (const r of rows) {
    const had = prevMap.has(r.external_id);
    const wasFound = prevMap.get(r.external_id) === true;
    if (r.encontrado && (!had || !wasFound)) {
      notifs.push({ type: 'persona_encontrada', payload: { external_id: r.external_id, nombre: r.nombre } });
    }
  }

  await sbUpsert('desaparecidos_external', rows);
  if (notifs.length) await sbInsert('notification_queue', notifs);
  return { upserted: rows.length, notifications: notifs.length };
}

/* ─── Ingesta: centros de acopio ──────────────────────────────────────────── */
async function ingestCentros(items: any[]) {
  const prev = await sbSelect('centros_acopio_external', 'external_id');
  const known = new Set(prev.map((r: any) => r.external_id));

  const rows = items.map(c => ({
    external_id: c.external_id, source: c.source, nombre: c.nombre,
    direccion: c.direccion ?? null, telefono: c.telefono ?? null,
    lat: typeof c.lat === 'number' ? c.lat : null,
    lng: typeof c.lng === 'number' ? c.lng : null,
    necesita: c.necesita ?? [], sobra: c.sobra ?? [], suministros: c.suministros ?? [],
    verificaciones: c.verificaciones ?? 0,
    created_source: c.created_at ?? null, last_synced: new Date().toISOString(),
  }));

  const notifs = rows
    .filter(r => !known.has(r.external_id))
    .map(r => ({ type: 'nuevo_centro', payload: { external_id: r.external_id, nombre: r.nombre, direccion: r.direccion } }));

  await sbUpsert('centros_acopio_external', rows);
  if (notifs.length) await sbInsert('notification_queue', notifs);
  return { upserted: rows.length, notifications: notifs.length };
}

/* ─── Helpers Supabase (PostgREST, sin dependencias) ──────────────────────── */
function sbHeaders(extra: Record<string, string> = {}) {
  return { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...extra };
}
async function sbSelect(table: string, select: string) {
  const res = await fetch(`${SB}/rest/v1/${table}?select=${encodeURIComponent(select)}`, { headers: sbHeaders() });
  if (!res.ok) throw new Error(`select ${table}: ${res.status}`);
  return res.json();
}
async function sbUpsert(table: string, rows: any[]) {
  const res = await fetch(`${SB}/rest/v1/${table}`, {
    method: 'POST',
    headers: sbHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`upsert ${table}: ${res.status} ${await res.text()}`);
}
async function sbInsert(table: string, rows: any[]) {
  const res = await fetch(`${SB}/rest/v1/${table}`, {
    method: 'POST', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`insert ${table}: ${res.status}`);
}
async function logRun(source: string, ok: boolean, count: number, error: string | null) {
  await fetch(`${SB}/rest/v1/sync_runs`, {
    method: 'POST', headers: sbHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify([{ source, ok, count, error }]),
  }).catch(() => {});
}

/* ─── HMAC (Web Crypto, timing-safe) — idéntico a GRADA/Krujens ───────────── */
function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...extra } });
}
async function verifyHmac(payload: string, secret: string, received: string): Promise<boolean> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  const expected = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  return timingSafeEqual(expected, received);
}
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
