# Plan de implementación: SismoVE → PWA instalable + Web Push (versión final)

> Hoja de ruta de arquitectura para una sesión de implementación futura. Autocontenido: puede ejecutarse sin leer ningún otro documento.
> Repo: `C:\Users\pparedes\Downloads\Venezuela` (sitio estático plano: los HTML viven en la raíz; `vercel.json` solo tiene `cleanUrls:true`; los endpoints de `api/` corren en Edge runtime).

---

## 1. Resumen y objetivos

### Qué se construye
Convertir SismoVE en una **PWA instalable** (icono en pantalla de inicio, arranque a pantalla completa, shell offline) y añadirle **Web Push** como segundo canal de notificación, reutilizando la lógica de deltas que ya alimenta Telegram en `api/notify.ts`.

### Qué gana el usuario
- **Acceso en emergencia aunque la red falle**: el shell de la app (HTML/CSS/JS y las páginas de instrucciones `calma`, `atrapado`, `replicas`, etc.) abre instantáneamente desde caché. En un sismo la conectividad es lo primero que cae; poder abrir la app y leer "qué hago ahora" sin red es la ganancia central.
- **Notificaciones push** de datos nuevos (sismos, personas reportadas, centros de acopio, zonas afectadas) en el dispositivo, sin necesidad de tener Telegram.
- **Instalación en 1 toque** (Android/desktop) o guiada (iPhone), sin pasar por tienda de apps.

### Qué NO cambia: Telegram sigue siendo el canal principal
- **Telegram permanece como el canal confiable y primario.** Razones: (a) entrega vía servidores de Telegram, sin depender de que el usuario instale la PWA; (b) funciona en iOS sin las restricciones de Web Push; (c) ya está en producción y probado.
- Web Push es **complemento, no reemplazo**. El cron enviará el mismo delta a ambos canales. Si Web Push falla o el usuario no se suscribió, Telegram cubre.
- **Frescura de datos = prioridad absoluta.** Datos viejos cacheados (un sismo de hace 12 h, un centro ya cerrado, una persona ya encontrada) son un riesgo en emergencia. Por eso: **nunca se precachean datos**, solo el shell estático. Todos los datos van *network-first* con caché únicamente como red de seguridad y aviso visual de "sin conexión".

### Realidad de la arquitectura de datos (clave para el Service Worker)
1. **Reportes ciudadanos en vivo (lo más crítico) → Supabase REST cross-origin.** En `app.html` está hardcodeado `SB_URL='https://lewueqvqdnnkdiqlkrvx.supabase.co'` con `SB_ANON` (anon key pública). Coverage/power/zona_reports se leen con `fetch` directo a `https://lewueqvqdnnkdiqlkrvx.supabase.co/rest/v1/...` y los POST de reportes van al mismo origen (`pushCommunityReport`). **Esta es la fuente de verdad en vivo.**
2. **`data/feed.js`** se carga como `<script src>` y setea `window.SISMOVE_FEED`. Es el bootstrap del arranque: **es shell estático, NO un dato a refrescar.** Debe ir cache-first.
3. **`data/feed.json`** se refetchea con `cache:'no-store'` pero **está estancado** (el scraper escribe a Supabase, no regenera `feed.json` en cada corrida). No es la fuente de frescura.

Consecuencia para el SW: el "dato en vivo" que importa cachear-nunca es **Supabase REST cross-origin**, no `/api/*` ni `feed.json`. El matching del SW debe basarse en host+path, no en substrings frágiles.

### Principios de diseño
1. **Shell cacheado, datos siempre en vivo.** Precache solo de recursos estáticos versionados; *network-first* (sin cachear) para Supabase REST.
2. **Aditivo y reversible.** Nada existente (Telegram, scraper, endpoints, enlace web) cambia su comportamiento; solo se añade.
3. **Sin spam.** El push reutiliza la lógica de deltas de `notify.ts`: solo se notifica cuando un conteo creció respecto a la línea base en `sync_runs`.

---

## 2. FASE 1 — PWA instalable (sin push)

Objetivo: que SismoVE sea instalable y abra offline. **Independiente y desplegable por sí sola**; entrega valor aunque la Fase 2 nunca llegue.

### 2.1 Archivos a crear

#### `manifest.json` (raíz del repo)
```json
{
  "name": "SismoVE — Red de Respuesta Sísmica",
  "short_name": "SismoVE",
  "description": "Qué hacer ahora: refugios, centros de acopio, personas y zonas afectadas.",
  "start_url": "/app",
  "scope": "/",
  "display": "standalone",
  "orientation": "portrait",
  "background_color": "#0b0f1a",
  "theme_color": "#4B3658",
  "lang": "es-VE",
  "categories": ["health", "utilities", "news"],
  "icons": [
    { "src": "/icons/icon-192.png",     "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "/icons/icon-512.png",     "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "/icons/maskable-192.png", "sizes": "192x192", "type": "image/png", "purpose": "maskable" },
    { "src": "/icons/maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```
Notas:
- **`start_url: "/app"` SIN query.** (a) con `caches.match` por defecto (`ignoreSearch:false`) un `start_url` con query no haría match con la entrada `/app` cacheada y la app caería a `offline.html` aun teniendo shell; (b) iOS es sensible a que `start_url` y `scope` coincidan. Para saber si se abrió como PWA, usar `window.matchMedia('(display-mode: standalone)').matches`, no un query param.
- `cleanUrls:true` ya sirve `/app` → `app.html`.
- Iconos mínimos para instalabilidad: 192 y 512 PNG `purpose:"any"`. Las entradas `maskable` van **separadas** y deben respetar la *safe zone* (logo dentro del 80% central).

#### `icons/` — assets PNG (en la RAÍZ del repo)
- `icon-192.png`, `icon-512.png` (logo sobre fondo morado `#4B3658`).
- `maskable-192.png`, `maskable-512.png` (logo con padding ~20%).
- `badge-72.png` (monocromo, para la badge de notificación de Fase 2).
- `apple-touch-icon.png` 180×180 (iOS ignora `maskable`).

#### `offline.html` (raíz)
Página mínima autocontenida que se muestra al navegar sin red:
- Mensaje: *"Sin conexión. SismoVE funciona, pero los sismos y reportes nuevos NO aparecen hasta que vuelvas a tener internet."*
- **No prometer mapa offline** (Leaflet y tiles vienen de CDN externo `unpkg.com`).
- Botón Reintentar + teléfonos de emergencia hardcodeados + recordatorio de que **Telegram es el canal confiable**.

#### `sw.js` (raíz — scope `/`)
```js
/* SismoVE Service Worker — shell cacheado, datos SIEMPRE en vivo */
const SHELL_VERSION = 'sismove-shell-v1';   // ⬆️ ver 2.6 sobre automatizar este bump

const SHELL = [
  '/', '/app',
  '/calma', '/atrapado', '/replicas', '/llama',
  '/familiar', '/ayudar', '/mascotas', '/zonas', '/acopio-global',
  '/offline.html',
  '/data/feed.js',
  '/icons/icon-192.png', '/icons/icon-512.png',
  '/manifest.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL_VERSION);
    const results = await Promise.allSettled(SHELL.map(u => cache.add(u)));
    results.forEach((r, i) => {
      if (r.status === 'rejected') console.warn('[SW] precache falló:', SHELL[i], r.reason);
    });
  })());
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== SHELL_VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

function esDatoEnVivo(url) {
  return url.hostname.endsWith('.supabase.co') && url.pathname.startsWith('/rest/v1/');
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (esDatoEnVivo(url)) { e.respondWith(networkOnlyConFallback(req)); return; }

  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try { return await fetch(req); }
      catch {
        const cached = await caches.match(req, { ignoreSearch: true });
        return cached || (await caches.match('/offline.html')) || new Response('Sin conexión', { status: 503 });
      }
    })());
    return;
  }

  e.respondWith(caches.match(req, { ignoreSearch: true }).then(r => r || fetch(req)));
});

async function networkOnlyConFallback(req) {
  try { return await fetch(req); }
  catch {
    return new Response(JSON.stringify({ offline: true, stale: true }),
      { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
}
```
Decisiones clave:
- **`esDatoEnVivo` por host+path**, no por substring (evita tratar `data/feed.js` como dato y romper el bootstrap offline).
- **Los datos NO se cachean** (`networkOnlyConFallback` no hace `cache.put`). Offline de datos = "vacío + `offline:true`" para no mostrar sismos viejos como actuales.
- **`addAll` reemplazado por `allSettled` + log** (un 404 no deja la PWA sin shell).
- **Rutas canónicas limpias** en `SHELL` (`/calma`, no `/calma.html`, por `cleanUrls`). Confirmar que cada ruta responde 200 antes de fijar la lista.
- **`navigate` usa `ignoreSearch:true`**.

### 2.2 Ediciones exactas en los HTML

#### `index.html` — tras el `<link>` de fuentes (en `<head>`)
```html
  <!-- PWA -->
  <link rel="manifest" href="/manifest.json" />
  <meta name="theme-color" content="#4B3658" />
  <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <meta name="apple-mobile-web-app-title" content="SismoVE" />
```

#### `app.html` — tras el `<title>` (ya tiene theme-color; opcional unificar a `#4B3658`)
```html
<link rel="manifest" href="/manifest.json" />
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="apple-mobile-web-app-title" content="SismoVE" />
```

#### Registro del SW + toast de actualización — antes de `</body>` (ambos HTML)
```html
<script>
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(reg => {
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing; if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) mostrarToastActualizar();
        });
      });
    }).catch(err => console.warn('[SW] falló', err));
    let recargado = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (recargado) return; recargado = true; location.reload();
    });
  });
}
function mostrarToastActualizar() {
  if (document.getElementById('sw-update-toast')) return;
  const b = document.createElement('div');
  b.id = 'sw-update-toast';
  b.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:9999;background:#4B3658;color:#fff;padding:10px 14px;border-radius:10px;font:14px system-ui;box-shadow:0 4px 16px rgba(0,0,0,.3)';
  b.innerHTML = 'Nueva versión disponible. <button id="sw-reload" style="margin-left:8px;background:#fff;color:#4B3658;border:0;border-radius:6px;padding:4px 8px;font-weight:700">Recargar</button>';
  document.body.appendChild(b);
  document.getElementById('sw-reload').onclick = () => location.reload();
}
</script>
```
> Registrar en `load`. El toast compensa el riesgo de `skipWaiting` en un monolito (`app.html` es grande con JS inline).

### 2.3 `vercel.json` — headers
```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "cleanUrls": true,
  "headers": [
    { "source": "/manifest.json", "headers": [
      { "key": "Content-Type", "value": "application/manifest+json" },
      { "key": "Cache-Control", "value": "public, max-age=3600" } ] },
    { "source": "/sw.js", "headers": [
      { "key": "Content-Type", "value": "application/javascript; charset=utf-8" },
      { "key": "Cache-Control", "value": "no-cache" } ] }
  ]
}
```
Claves: `sw.js` con `no-cache` → el navegador siempre revalida el SW. `Service-Worker-Allowed` no hace falta (SW en raíz, scope `/`).

### 2.4 UI de "Instalar"
- **Android / desktop (Chrome/Edge):** capturar `beforeinstallprompt`, prevenir default, mostrar "Instalar SismoVE"; al pulsar → `deferredPrompt.prompt()`. Ocultar tras `appinstalled` o si ya en standalone.
- **iPhone/iPad (Safari):** **no existe `beforeinstallprompt`**. Detectar iOS + Safari + no-standalone y mostrar tarjeta de instrucciones: *Compartir (↑) → Agregar a inicio → Agregar.* Mostrar solo en Safari iOS.

### 2.5 Estrategia de caché — resumen

| Recurso | Estrategia | ¿Se cachea? | Motivo |
|---|---|---|---|
| Shell HTML (`/`, `/app`, instrucciones) | cache-first (precache, `ignoreSearch`) | Sí, versionado | Abrir offline en sismo |
| `data/feed.js` (bootstrap) | cache-first | Sí | Es shell, no dato |
| Iconos, apple-touch | cache-first | Sí | Casi nunca cambian |
| `manifest.json` | cache-first + revalida | Sí | Pequeño |
| Supabase REST (`*.supabase.co/rest/v1/*`) | **network-first** | **No** (fallback `offline:true`) | Fuente de verdad en vivo |
| `data/feed.json` (legacy/estancado) | red directa | No | Hoy no aporta frescura |
| `/api/*` (sync, drive-docs, towers) | red directa | No | Datos de terceros |
| Leaflet + tiles (unpkg CDN) | red directa | No | No hay mapa offline (ver M1) |

### 2.6 Versionado del SW (no dejar usuarios con shell viejo)
- `SHELL_VERSION` controla la caché; `activate` borra las viejas. Automatizar el bump en predeploy:
```bash
v="sismove-shell-$(date +%Y%m%d)-$(git rev-parse --short HEAD)"
sed -i "s/const SHELL_VERSION = '[^']*'/const SHELL_VERSION = '$v'/" sw.js
```
(En PowerShell, reemplazo equivalente con `(Get-Content sw.js) -replace ...`.) Si no se automatiza, subir `SHELL_VERSION` a mano en CADA deploy que toque el shell.

---

## 3. FASE 2 — Web Push

Requiere Fase 1 desplegada (SW activo).

### 3.1 Claves VAPID
```bash
npx web-push generate-vapid-keys
```
Guardar como **env vars en Vercel** (no en repo/GitHub): `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT=mailto:pedro.paredes@kenmei.ai`. La pública se sirve al cliente vía `GET /api/vapid-public`.

### 3.2 Tabla Supabase — `supabase/schema_push.sql` (nuevo)
```sql
-- A DIFERENCIA de zona_reports/coverage/power, esta tabla NO lleva policy de
-- insert anon. La anon key es pública; solo service_role escribe vía /api/push-subscribe.
create table if not exists push_subscriptions (
  id            uuid primary key default gen_random_uuid(),
  endpoint      text not null,
  subscription  jsonb not null,
  zona          text,
  user_agent    text,
  active        boolean default true,
  verified_at   timestamptz,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  constraint push_unique_endpoint unique (endpoint)
);
create index if not exists idx_push_active on push_subscriptions(active) where active = true;
create index if not exists idx_push_zona   on push_subscriptions(zona)   where active = true;
alter table push_subscriptions enable row level security;
-- SIN policies: con RLS habilitado y sin policy, anon no lee ni escribe; service_role ignora RLS.
-- NO replicar el patrón "insert with check(true)" de schema_zonas.sql aquí.
```

### 3.3 `api/push-subscribe.ts` (nuevo, Edge — solo escribe, con allowlist anti-abuso)
```ts
export const config = { runtime: 'edge' };
const SB = process.env.SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const PUSH_HOSTS = ['fcm.googleapis.com','updates.push.services.mozilla.com','.push.apple.com','.notify.windows.com','.push.services.mozilla.com'];
function endpointValido(ep: string): boolean {
  try { const h = new URL(ep).hostname; return PUSH_HOSTS.some(d => d.startsWith('.') ? h.endsWith(d) : h === d); } catch { return false; }
}
export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return j({ error: 'method' }, 405);
  let body: any; try { body = await req.json(); } catch { return j({ error: 'bad_json' }, 400); }
  const sub = body?.subscription;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return j({ error: 'bad_subscription' }, 400);
  if (!endpointValido(sub.endpoint)) return j({ error: 'bad_endpoint_host' }, 400);
  const row = { endpoint: sub.endpoint, subscription: sub, zona: body.zona ?? null, user_agent: (body.user_agent ?? '').slice(0,400), active: true, updated_at: new Date().toISOString() };
  const r = await fetch(`${SB}/rest/v1/push_subscriptions?on_conflict=endpoint`, {
    method: 'POST',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([row]),
  });
  return r.ok ? j({ ok: true }) : j({ error: 'db', status: r.status }, 502);
}
const j = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
```

### 3.4 `api/vapid-public.ts` (nuevo, Edge)
```ts
export const config = { runtime: 'edge' };
export default async () => new Response(
  JSON.stringify({ key: process.env.VAPID_PUBLIC_KEY || '' }),
  { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' } }
);
```

### 3.5 Handler de push en el SW — añadir a `sw.js`
```js
self.addEventListener('push', (e) => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch {}
  const n = d.notification || d;
  e.waitUntil(self.registration.showNotification(n.title || 'SismoVE', {
    body: n.body || 'Información actualizada', icon: n.icon || '/icons/icon-192.png',
    badge: '/icons/badge-72.png', tag: n.tag || 'sismove-update', renotify: true, data: d.data || {}
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/app';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ws => {
    const open = ws.find(w => w.url.includes('/app'));
    return open ? open.focus() : clients.openWindow(url);
  }));
});
```

### 3.6 Flujo de permiso en el cliente (`app.html`)
- **Nunca** pedir permiso al cargar. Botón explícito "🔔 Recibir alertas de sismos" (gesto de usuario; requisito iOS).
```js
window.subscribeToPush = async function () {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) { alert('Tu navegador no soporta push. Usa Telegram.'); return; }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { alert('Permiso rechazado. Telegram sigue disponible.'); return; }
  const reg = await navigator.serviceWorker.ready;
  const { key } = await fetch('/api/vapid-public').then(r => r.json());
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });
  const res = await fetch('/api/push-subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub.toJSON(), user_agent: navigator.userAgent }) });
  alert(res.ok ? '✅ Listo: recibirás alertas de SismoVE.' : 'No se pudo guardar. Intenta más tarde.');
};
function urlBase64ToUint8Array(b64) {
  const pad = '='.repeat((4 - b64.length % 4) % 4);
  const s = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(s); const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
```
- En **iPhone** el push solo funciona con la PWA **instalada** (iOS 16.4+). Mostrar el botón solo si `window.navigator.standalone === true` en iOS; si no, "instala primero". iOS no mantiene estado entre lanzamientos: re-evaluar permiso en cada arranque.

### 3.7 Envío desde el cron — decisión Edge vs Node
**Punto crítico.** `api/notify.ts` corre en **Edge**. La librería **`web-push` (npm) depende del módulo `crypto` de Node.js → NO funciona en Edge** (solo expone Web Crypto).

**Decisión: Opción A — separar el envío en una Node Function.**
- Crear `api/push-send.ts` con `export const config = { runtime: 'nodejs' }` usando `web-push`.
- `notify.ts` se mantiene en Edge; tras calcular deltas, **llama por HTTP** a `/api/push-send`.
- Añadir `web-push` a `package.json` (hoy NO tiene `dependencies`).

> Alternativa (Opción B): todo en Edge con `@block65/webcrypto-web-push` o `webpush-webcrypto` (VAPID/ES256 sobre Web Crypto). Menos veteranas; validar antes. Por defecto se usa A.

#### `package.json` — añadir dependencia
```json
{ "name": "sismove", "version": "0.1.0", "private": true, "type": "module",
  "scripts": { "scrape": "node scraper/scrape.mjs", "scrape:post": "node scraper/scrape.mjs --post" },
  "dependencies": { "web-push": "^3.6.7" },
  "engines": { "node": ">=18" } }
```

#### `api/push-send.ts` (nuevo, **Node runtime**)
```ts
export const config = { runtime: 'nodejs' };
import webpush from 'web-push';
const SB = process.env.SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SECRET = process.env.SCRAPER_WEBHOOK_SECRET;
const sbH = (extra = {}) => ({ apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...extra });
webpush.setVapidDetails(process.env.VAPID_SUBJECT!, process.env.VAPID_PUBLIC_KEY!, process.env.VAPID_PRIVATE_KEY!);
export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if ((req.query?.key || '') !== SECRET) return res.status(403).json({ error: 'forbidden' });
  let payloadIn: any = req.body;
  if (typeof payloadIn === 'string') { try { payloadIn = JSON.parse(payloadIn); } catch { payloadIn = {}; } }
  const deltas = payloadIn?.deltas;
  if (!Array.isArray(deltas) || !deltas.length) return res.status(200).json({ status: 'sin_deltas' });
  const r = await fetch(`${SB}/rest/v1/push_subscriptions?select=id,subscription&active=eq.true`, { headers: sbH() });
  const subs = r.ok ? await r.json() : [];
  const body = deltas.map((d: any) => `${d.label}: +${d.add} (total ${d.total})`).join('\n');
  const payload = JSON.stringify({ notification: { title: '🔔 SismoVE actualizado', body, icon: '/icons/icon-192.png', tag: 'sismove-update' }, data: { url: '/app' } });
  let sent = 0;
  await Promise.all(subs.map(async (s: any) => {
    try { await webpush.sendNotification(s.subscription, payload); sent++; }
    catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410)
        await fetch(`${SB}/rest/v1/push_subscriptions?id=eq.${s.id}`, { method: 'PATCH', headers: sbH({ Prefer: 'return=minimal' }), body: JSON.stringify({ active: false }) }).catch(() => {});
    }
  }));
  return res.status(200).json({ status: 'push_enviado', total: subs.length, sent });
}
```

#### Enganche en `api/notify.ts` — ubicación corregida
**Importante:** `notify.ts` tiene **returns tempranos** que el push NO debe saltarse (cuando no hay TOKEN de Telegram o no hay suscriptores, y el return final). El push debe dispararse **justo después del bucle de cálculo de deltas**, en su propio bloque que solo depende de `deltas.length`, independiente de Telegram:
```ts
  // ── Web Push en paralelo (complementario; Telegram sigue siendo el principal) ──
  // Va AQUÍ (tras el cálculo de deltas), no antes del return final, para que se ejecute
  // aunque Telegram salga por un return temprano (sin token / sin subs).
  let pushSent = 0;
  if (process.env.VAPID_PUBLIC_KEY && deltas.length) {
    try {
      const pr = await fetch(`https://sismove-venezuela.vercel.app/api/push-send?key=${encodeURIComponent(SECRET!)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deltas }),
      });
      if (pr.ok) pushSent = (await pr.json()).sent ?? 0;
    } catch { /* best-effort; nunca rompe Telegram */ }
  }
```
- **Dominio fijo** `https://sismove-venezuela.vercel.app` para el hop Edge→Node (no derivar de `req.url`).
- Si VAPID no está, el bloque se salta → Fase 1 puede desplegarse sin Fase 2.
- Añadir `push_sent: pushSent` a los returns para diagnóstico.

### 3.8 Cron (`.github/workflows/cron.yml`)
- **Sin cambios de lógica.** El paso final ya hace `curl "$BASE/api/notify?key=$KEY"`, que ahora dispara el push internamente.
- Registrar `VAPID_*` en env vars de Vercel (no GitHub Secrets). Documentar con un comentario.

### 3.9 Reglas anti-spam
- Reutiliza el filtro de deltas de `notify.ts` (solo cuando un conteo creció). Una notificación por corrida con todos los deltas agrupados. `tag:'sismove-update'`+`renotify:true`. Sin push en la primera corrida. Limpieza de suscripciones muertas (404/410 → `active=false`).

---

## 4. Pruebas (checklist)

### Fase 1
**Android/Chrome:** Lighthouse PWA sin errores · botón Instalar funciona · standalone sin barra URL · modo avión: shell abre, datos muestran "sin conexión" (no viejos) · SW activo + `feed.js` cacheado · cada ruta de `SHELL` responde 200.
**Desktop:** instala como app · offline OK · subir `SHELL_VERSION` → toast "nueva versión" → recargar entra la nueva.
**iPhone (Safari 16.4+):** tarjeta de instrucciones solo en Safari · Agregar a inicio → standalone · `start_url` limpio hace match offline · offline tras instalar.

### Fase 2
**Android:** permiso crea fila en `push_subscriptions` · `/api/notify` con delta → llega push, click abre `/app` · funciona con PWA cerrada · Telegram + push en la misma corrida.
**Desktop:** suscripción/recepción sin instalar.
**iPhone (16.4+):** solo tras instalar como PWA · llega con PWA cerrada · en pestaña Safari muestra "instala primero".
**Robustez/seguridad:** suscripción caducada → `active=false` · VAPID ausente → Telegram sigue (`push_sent:0`) · **camino sin Telegram** (TOKEN ausente + deltas) → push SÍ se envía · POST a `push_subscriptions` con anon key → rechazado (RLS sin policy) · endpoint host no-allowlist → `400`.

---

## 5. Criterios de aceptación
**Fase 1:** instalable en Android/desktop/iPhone · abre offline con shell + instrucciones · datos nunca obsoletos sin aviso · Telegram/scraper/enlace/endpoints intactos.
**Fase 2:** un delta genera push **y** Telegram en la misma corrida (incluso si Telegram cae por return temprano) · sin duplicados/spam · suscripciones muertas se limpian · `push_subscriptions` no escribible con anon key · borrar VAPID deja Fase 1 + Telegram intactos.

---

## 6. Despliegue y rollback
**Fase 1** (un deploy, aditivo): añadir assets/manifest/sw/offline/vercel headers + ediciones HTML → deploy → verificar headers y rutas SHELL 200 → probar instalación/offline.
**Fase 2** (dos sub-pasos): (1) `schema_push.sql` + `web-push` en package.json + VAPID en Vercel + desplegar push-subscribe/vapid-public/push-send + handlers SW (bump `SHELL_VERSION`); validar suscripción y rechazo anon. (2) Desplegar enganche en `notify.ts`; validar push e2e incl. camino sin Telegram.
**Rollback:** SW → `sw.js` kill-switch (`self.registration.unregister()` + borra cachés + bump versión). Push → quitar `VAPID_PUBLIC_KEY` en Vercel (el bloque se salta) o revertir el commit del enganche. Manifest/headers → revertir `vercel.json`. Cada fase en su commit para revertir granular.

---

## 7. Estimación de esfuerzo
| Bloque | Esfuerzo |
|---|---|
| Iconos (6-7 PNG) | 1-2 h |
| manifest + vercel.json + metas | 0.5 h |
| sw.js + offline.html | 1.5-2.5 h |
| Registro SW + toast + UI instalar (Android + tarjeta iOS) | 1.5-2 h |
| Automatizar SHELL_VERSION | 0.5 h |
| **Fase 1** | **~0.5-1 día** |
| VAPID + schema_push + dep + env | 0.5-1 h |
| push-subscribe + vapid-public | 1-1.5 h |
| push-send (Node + web-push) | 1-2 h |
| Handlers SW + UI permiso | 1-2 h |
| Enganche notify.ts + e2e | 1-1.5 h |
| **Fase 2** | **~1-1.5 días** |
| Pruebas cross-device | 0.5-1 día |
| **Total** | **~2.5-3.5 días** |

---

## 8. Riesgos y limitaciones
- **iOS (el más restrictivo):** push solo con PWA instalada (16.4+, desde Safari); sin `beforeinstallprompt` (instalación manual); gesto de usuario obligatorio; no mantiene estado entre lanzamientos; `start_url` sensible. **Telegram cubre el hueco → canal principal.**
- **Mapa offline NO disponible (M1):** Leaflet + tiles vienen de `unpkg.com`/CDN cross-origin, no se precachean. El copy no debe prometer mapa offline. Futuro: autoalojar Leaflet.
- **Frescura de datos:** mitigado con network-first estricto + nunca `cache.put` de datos + fallback `offline:true`. Probar explícitamente.
- **Service Worker:** SW pegado mitigado con `no-cache` + versión automatizada + limpieza en `activate` + toast + kill-switch. `cache.addAll` atómico evitado con `allSettled`.
- **Seguridad suscripciones (A1):** anon key pública → `push_subscriptions` sin policy de insert anon; endpoint valida host contra allowlist.
- **Edge + crypto (A2):** `web-push` no corre en Edge → Node Function `push-send` (Opción A).
- **Entrega no garantizada:** Web Push depende del servicio del navegador/dispositivo online → Telegram = principal, push = complemento.

---

## 9. Inventario de archivos
**Crear:** `manifest.json`, `sw.js`, `offline.html`, `icons/` (icon-192/512, maskable-192/512, badge-72, apple-touch-icon), `api/push-subscribe.ts` (Edge), `api/push-send.ts` (**Node**), `api/vapid-public.ts` (Edge), `supabase/schema_push.sql` (RLS sin policy anon).
**Modificar:** `package.json` (+`web-push`), `vercel.json` (headers), `index.html` (metas + registro SW), `app.html` (metas + registro SW + UI instalar + UI push), `api/notify.ts` (bloque push tras el cálculo de deltas + `push_sent` en returns), `.github/workflows/cron.yml` (solo comentario VAPID).
**Sin cambios:** scraper, `bot_subscribers`, lógica Telegram, sync_*, drive-docs, demás endpoints, `data/feed.js` (se cachea como shell).
