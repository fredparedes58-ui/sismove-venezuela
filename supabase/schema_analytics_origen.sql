-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ SismoVE · Analítica: origen de las visitas (fuente + ubicación aproximada)   ║
-- ║  Todo ANÓNIMO y agregado. La ubicación es por país/región/ciudad aproximada   ║
-- ║  (de la IP, vía Vercel) — NO es GPS ni dato personal. Columnas nullable.       ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

alter table analytics_events add column if not exists ref    text;  -- fuente/referente: whatsapp, google, facebook, directo, <host>...
alter table analytics_events add column if not exists pais   text;  -- código de país ISO-2 (VE, CO, US, ES...)
alter table analytics_events add column if not exists region text;  -- código de región/estado (de Vercel)
alter table analytics_events add column if not exists ciudad text;  -- ciudad aproximada (de la IP)

create index if not exists idx_ae_ref  on analytics_events(ref);
create index if not exists idx_ae_pais on analytics_events(pais);

-- Ahora TODO el registro pasa por /api/track (service_role), así que ya no hace falta
-- el insert anónimo directo: lo retiramos para cerrar la inserción abierta a la tabla.
drop policy if exists ae_insert on analytics_events;
