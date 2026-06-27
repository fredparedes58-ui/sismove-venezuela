/**
 * SismoVE · Sync de ingresos hospitalarios: Google Drive (Docs) → Supabase
 *
 * Lee los Google Docs de la carpeta (lista de ingresos), los exporta como texto,
 * los parsea (separando por el número de registro secuencial), REDACTA la cédula
 * y hace upsert en `hospital_admisiones`. Throttle 30 min (sync perezoso por visita).
 * El frontend y el bot luego buscan por nombre en Supabase.
 */
export const config = { runtime: 'edge' };

const SB = process.env.SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const FOLDERS = (process.env.DRIVE_FOLDER_IDS || process.env.DRIVE_FOLDER_ID || '1o36ifaRz45kAs5rKzci49aD0mP5JB_YI,1OIUMzrZzRpcTTE8olKT0lk6-jRFO3ztM').split(',').map(s => s.trim()).filter(Boolean);
const MAX_DEPTH = 4, MAX_FOLDERS = 80;
const THROTTLE_MIN = 30;

// Palabras que NO son nombres de persona (encabezados / fragmentos del tabulado)
const NON_NAMES = /^(triaje|servicio|edad|hospital|hopital|fallecid\w*|observaci\w*|a[nñ]os|sin nombre|n\/?a|paciente|nombre|apellidos|total|masculino|femenino)$/i;

function sbH(extra: Record<string, string> = {}) {
  return { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...extra };
}

async function listEntries(id: string): Promise<{ id: string; name: string; url: string }[]> {
  const html = await (await fetch(`https://drive.google.com/embeddedfolderview?id=${id}#list`, { headers: { 'User-Agent': 'Mozilla/5.0 (SismoVE)' } })).text();
  const re = /<div class="flip-entry"[^>]*id="entry-([^"]+)"[\s\S]*?<a href="([^"]+)"[\s\S]*?<div class="flip-entry-title">([^<]*)<\/div>/g;
  const out: any[] = []; let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.push({ id: m[1], name: m[3].trim(), url: m[2] });
  return out;
}
// Docs conocidos (semilla fija): el listado embeddedfolderview es INESTABLE y a veces omite
// el consolidado → siempre los parseamos aunque no aparezcan en el listado.
const KNOWN_DOCS = [
  { id: '125LObYNRazMhUuxeF8FFthiA5YJaGFyApKiUHyO4olo', name: 'Registro maestro de pacientes' },
  { id: '1SHnWBNnzxsJ30Yr1bY8cF3SP2By7mX2jtquHiyKLesU', name: 'Listas de personas en múltiples hospitales' },
];
// Recorre TODAS las carpetas (FOLDERS) recursivamente y junta TODOS los Google Docs +
// la semilla fija (dedup por id).
async function listDocs(): Promise<{ id: string; name: string }[]> {
  const docs: { id: string; name: string }[] = [...KNOWN_DOCS];
  const seenFolders = new Set<string>(); let visited = 0;
  const queue: { id: string; depth: number }[] = FOLDERS.map(id => ({ id, depth: 0 }));
  while (queue.length && visited < MAX_FOLDERS) {
    const { id, depth } = queue.shift()!;
    if (seenFolders.has(id)) continue; seenFolders.add(id); visited++;
    let entries: { id: string; name: string; url: string }[] = [];
    try { entries = await listEntries(id); } catch { continue; }
    for (const e of entries) {
      if (e.url.includes('/drive/folders/')) { if (depth < MAX_DEPTH && !seenFolders.has(e.id)) queue.push({ id: e.id, depth: depth + 1 }); }
      else if (e.url.includes('/document/')) docs.push({ id: e.id, name: e.name });
    }
  }
  const seen = new Set<string>();
  return docs.filter(d => seen.has(d.id) ? false : (seen.add(d.id), true));
}

// Formato actual del maestro: celdas tabuladas  N° · HOSPITAL · APELLIDOS Y NOMBRES · EDAD.
// Detecta el inicio de cada registro por el patrón «Nº␣Hospital» (no depende de numeración
// perfecta: si hay un hueco en la secuencia no se desincroniza). NO contiene cédulas.
function parseDoc(txt: string, source: string) {
  const cells = txt.replace(/﻿/g, '').split(/[\t\r\n]+/).map(s => s.trim()).filter(Boolean);
  let start = cells.findIndex(c => /^EDAD$/i.test(c)); start = start >= 0 ? start + 1 : 0;
  const out: { nombre: string; hospital: string | null; fecha: string | null; source: string }[] = [];
  for (let i = start; i < cells.length; i++) {
    const c = cells[i]; let hospital: string | null = null; let idx = i;
    const m = c.match(/^(\d{1,4})\s+([A-Za-zÁÉÍÓÚÑáéíóúñ].*)$/);
    if (m) hospital = m[2].trim();
    else if (/^\d{1,4}$/.test(c) && /[A-Za-z]/.test(cells[i + 1] || '') && !/^\d/.test(cells[i + 1] || '')) hospital = (cells[++idx] || '').trim();
    else continue;
    const nombre = (cells[idx + 1] || '').trim();
    const ec = (cells[idx + 2] || '').trim(); const edad = /^\d{1,3}$/.test(ec) ? ec : '';
    const ok = nombre.length >= 3 && /[A-Za-zÑñ]/.test(nombre) && !/^\d/.test(nombre)
      && !/hospital|hopital|cl[ií]nic|centro/i.test(nombre) && !NON_NAMES.test(nombre);
    if (ok) {
      if (hospital && (NON_NAMES.test(hospital) || hospital.length < 4)) hospital = null;
      out.push({ nombre: edad ? `${nombre} (${edad} años)` : nombre, hospital, fecha: null, source });
      i = idx + (edad ? 2 : 1);
    }
  }
  return out;
}

export default async function handler(req: Request): Promise<Response> {
  if (!SB || !SERVICE) return json({ error: 'no_supabase' }, 503);
  const force = (() => { try { const k = new URL(req.url).searchParams.get('key'); return !!k && k === process.env.SCRAPER_WEBHOOK_SECRET; } catch { return false; } })();
  try {
    // Throttle: ¿hubo un sync EXITOSO hace menos de THROTTLE_MIN? (solo cuenta ok=true)
    const last = await fetch(`${SB}/rest/v1/sync_runs?source=eq.hospitales&ok=eq.true&order=ran_at.desc&limit=1`, { headers: sbH() }).then(r => r.json()).catch(() => []);
    if (!force && Array.isArray(last) && last[0]?.ran_at && Date.now() - new Date(last[0].ran_at).getTime() < THROTTLE_MIN * 60000) {
      return json({ status: 'cached', count: await count(), last_sync: last[0].ran_at });
    }

    const docs = await listDocs();
    const seen = new Set<string>(); const rows: any[] = []; const batch = new Date().toISOString();
    for (const d of docs) {
      try {
        const txt = await (await fetch(`https://docs.google.com/document/d/${d.id}/export?format=txt`)).text();
        for (const e of parseDoc(txt, d.name)) {
          const id = `${e.nombre}|${e.hospital || ''}`.toLowerCase().replace(/\s+/g, ' ').slice(0, 200);
          if (seen.has(id)) continue; seen.add(id);
          rows.push({ id, nombre: e.nombre, hospital: e.hospital, fecha: e.fecha, source: e.source, updated_at: batch });
        }
      } catch { /* documento no parseable, se omite */ }
    }

    if (rows.length) {
      for (let i = 0; i < rows.length; i += 500) {
        const r = await fetch(`${SB}/rest/v1/hospital_admisiones`, { method: 'POST', headers: sbH({ Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify(rows.slice(i, i + 500)) });
        if (!r.ok) throw new Error(`upsert ${r.status}: ${(await r.text()).slice(0, 120)}`);
      }
      // NO borramos stale: en un buscador de familiares es preferible un nombre de más
      // (con aviso de "confirmar con el hospital") que perder uno por un listado inestable.
    }
    await fetch(`${SB}/rest/v1/sync_runs`, { method: 'POST', headers: sbH({ Prefer: 'return=minimal' }), body: JSON.stringify([{ source: 'hospitales', ok: true, count: rows.length }]) }).catch(() => {});
    return json({ status: 'synced', count: rows.length, docs: docs.length });
  } catch (e: any) {
    return json({ error: 'sync_failed', detail: e?.message }, 500);
  }
}

async function count(): Promise<number | null> {
  try {
    const r = await fetch(`${SB}/rest/v1/hospital_admisiones?select=id`, { headers: sbH({ Prefer: 'count=exact', Range: '0-0' }) });
    return parseInt((r.headers.get('content-range') || '').split('/')[1] || '0', 10);
  } catch { return null; }
}
function json(b: unknown, s = 200): Response {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
}
