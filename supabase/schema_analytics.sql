-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ SismoVE · Analítica propia ANÓNIMA (sin PII): visitas + interacciones       ║
-- ║ Cualquiera INSERTA eventos (anon); la LECTURA es solo vía /api/analytics     ║
-- ║ con clave de admin (no hay policy de SELECT para anon → eventos privados).   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

create table if not exists analytics_events (
  id      bigint generated always as identity primary key,
  ev      text not null,        -- visit | view | search | report | bot
  page    text,                 -- home | ayuda | desap | ninos | refugios | panel | bot | info ...
  session text,                 -- id aleatorio anónimo (localStorage); NO es PII
  ts      timestamptz default now()
);
create index if not exists idx_ae_ev   on analytics_events(ev);
create index if not exists idx_ae_ts   on analytics_events(ts);
create index if not exists idx_ae_page on analytics_events(page);

alter table analytics_events enable row level security;
drop policy if exists ae_insert on analytics_events;
create policy ae_insert on analytics_events for insert with check (true);   -- registrar eventos (anon)
-- SIN policy de select → anon NO puede leer; el panel lee vía /api/analytics (service_role + ADMIN_KEY).
