# SismoVE · Red de Respuesta Sísmica 🇻🇪

Plataforma de ayuda ante el terremoto en Venezuela: **dashboard + scraping de fuentes oficiales + bot de Telegram con IA**. Conecta a quien necesita ayuda con desaparecidos, centros de acopio y emergencias.

> ⚠️ Agregamos datos de portales **oficiales públicos** con fines humanitarios. Los teléfonos son los oficiales aportados. La app no garantiza localizar personas.

## Arquitectura

```
Fuentes oficiales            scraper (cada 10 min)        nuestro backend            consumidores
─────────────────            ─────────────────────        ───────────────            ───────────
venezuelatebusca.com   ─┐                                ┌─ Supabase (_external) ─┬─ Dashboard (index.html)
centro-de-acopio-ven   ─┼─▶ scraper/scrape.mjs ──HMAC──▶ │  desaparecidos_external │
desaparecidos-terremoto─┘    (firma SHA-256)    webhook  └─ centros_acopio_external├─ Bot Telegram (Claude)
                                              api/webhooks/scraper.ts                └─ notification_queue
```

- **Scraping** (patrón *Krujens*): `scraper/scrape.mjs` lee las APIs Supabase de las fuentes, normaliza, firma HMAC-SHA256 y envía al webhook Edge, que hace *upsert* + detección de cambios + encola notificaciones.
- **Bot** (patrón *VITAS Coach Copilot*): `api/telegram/webhook.ts` — Claude con *tool use* sobre los datos reales. Reglas: nunca prometer encontrar personas, recomendar Cruz Roja, derivar a 911.
- **Dashboard**: `index.html` (PWA en un archivo). Lee `data/feed.js` (sin servidor) o `data/feed.json` (con servidor, refresco cada 5 min).
- **Mapas en vivo** (vista "Mapas", 4 capas):
  - 📦 **Acopio** — centros reales del scraper, agrupados por ciudad.
  - 📶 **Cobertura móvil** — reportes de la comunidad (señal/sin señal por operadora) **+ torres reales de OpenCelliD** (con su alcance estimado) cuando se configura `OPENCELLID_API_KEY`.
  - ⚡ **Luz / apagones** — reportes de la comunidad (no hay API pública en tiempo real; el mapa colaborativo es la vía real).
  - ⚠️ **Áreas afectadas** — sismos reales de **USGS** (M7.5/M7.2 de Yumare + réplicas, círculos por magnitud) + estados más afectados.
  - En producción los reportes comunitarios van a Supabase (`coverage_reports`, `power_reports`).

## Fuentes (descubiertas por reconocimiento)

| Fuente | Backend | Tabla | Estado scraper |
|--------|---------|-------|----------------|
| venezuelatebusca.com | Supabase REST (anon) | `desaparecidos` | ✅ |
| centro-de-acopio-ven.vercel.app | Supabase REST (publishable) | `centros_de_acopio` | ✅ (25 centros reales) |
| desaparecidosterremotovenezuela.com | Next.js Server Actions | — | ⏳ Playwright (fase 2) |
| **USGS** (sismos / áreas afectadas) | FDSN event API (geojson) | — | ✅ sin API key |
| **OpenCelliD** (torres / cobertura) | snapshot keyless (~96k hist.) + export país con token (~2.3k recientes) + API en vivo por zona | — | ✅ 98.294 torres (render por viewport, barrio a barrio) + "ver en vivo" |

## Probar ya (local, sin desplegar)

```bash
node scraper/scrape.mjs      # genera data/feed.json + data/feed.js con datos reales
```
Abre `index.html` y entra a **Buscar** (desaparecidos) y **Acopio** (centros reales con qué necesitan).
> El host de venezuelatebusca puede estar bloqueado en algunas redes; desde tu PC/Vercel/GitHub funciona.

### Torres reales de cobertura (OpenCelliD, CC-BY-SA 4.0)
Dos fuentes combinadas en `data/towers.js` (formato compacto `[lat,lng,opIdx,radioIdx,range,recent]`), que el dashboard carga y dibuja **por viewport** (cualquier barrio/pueblo del país):

1. **Histórico keyless** (densidad, ~95.997 torres, ~2017). Extracción única en streaming (no guarda los 719 MB):
   ```bash
   curl -s https://datasets.clickhouse.com/cell_towers.csv.xz | xz -dc | awk -F, 'NR>1 && $2=="734"' > data/towers_ve.csv
   ```
2. **Recientes con token** (export por país, ~2.297 torres confirmadas ≤18 meses, LTE-heavy). Requiere `OPENCELLID_API_KEY` (límite free: **2 descargas/archivo/día**):
   ```bash
   node scraper/fetch-fresh-towers.mjs        # baja MCC 734 (solo Venezuela, gzip ~42 KB) → towers_ve_fresh.csv
   ```
3. **Integrar** ambas (marca las recientes con `recent=1` → ● blanco en el mapa):
   ```bash
   node scraper/import-towers.mjs             # genera data/towers.js + feed.torres
   ```

El mapa muestra: ● **blanco** = torre confirmada ≤18 m (prob. activa) · tenue = histórica. El **estado en vivo real** lo dan los reportes comunitarios. Botón **"Ver esta zona EN VIVO"** → `api/towers/live.ts` consulta OpenCelliD para el recuadro visible (cabe en el límite de 4 km² del free tier; token server-side). Atribución obligatoria: *Datos de torres © OpenCelliD (CC-BY-SA 4.0)*.

## Desplegar (producción)

1. **Supabase**: crea proyecto → ejecuta `supabase/schema.sql` en el SQL Editor.
2. **Vercel**: importa el repo. Variables de entorno (ver `.env.example`):
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`,
   `SCRAPER_WEBHOOK_SECRET` (`openssl rand -hex 32`), `ANTHROPIC_API_KEY`,
   `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `OPENCELLID_API_KEY` (torres, gratis en opencellid.org).
3. **Scraping cada 10 min** (GitHub Actions): en *Settings → Secrets* del repo añade
   `SCRAPER_WEBHOOK_URL` (= `https://TU-APP.vercel.app/api/webhooks/scraper`) y
   `SCRAPER_WEBHOOK_SECRET`. El workflow `.github/workflows/scrape.yml` ya corre `*/10 * * * *`.
4. **Bot Telegram** (~5 min):
   ```bash
   # token con @BotFather, luego registra el webhook:
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
     -d url="https://TU-APP.vercel.app/api/telegram/webhook" \
     -d secret_token="<TELEGRAM_WEBHOOK_SECRET>"
   ```
5. **Dashboard con datos en vivo**: apunta `index.html` a leer de Supabase (anon, solo lectura) en vez de `data/feed.js` — o sirve `data/feed.json` actualizándolo desde el cron.

## Estructura
```
Venezuela/
├── index.html                     # Dashboard / PWA (app ciudadana + panel + bot intake + info)
├── data/feed.json · feed.js       # Salida del scraper (datos reales)
├── scraper/scrape.mjs             # Scraper de las 3 fuentes (→ feed + webhook HMAC)
├── api/
│   ├── webhooks/scraper.ts        # Ingesta Edge (HMAC → Supabase → notificaciones)
│   └── telegram/webhook.ts        # Bot Telegram + Claude (tool use)
├── supabase/schema.sql            # Tablas + RLS
├── .github/workflows/scrape.yml   # Cron cada 10 min
├── vercel.json · .env.example
└── README.md
```

## Reglas del agente (datos oficiales)
- **Desaparecidos**: portales + cómo registrar + recomendar Cruz Roja · **nunca prometer encontrar**.
- **"No encuentro a mi familia"** → Cruz Roja Venezolana **0422 799 4880**.
- **Peligro inmediato** → 911 · Protección Civil Nacional 0800-724-8451 · Caracas/Valencia (ver app).
- **Centros de acopio**: localizar, cómo donar, artículos prioritarios (campo `necesita`).
