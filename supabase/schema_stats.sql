-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ SismoVE · Cifras oficiales del terremoto (banner rojo)                     ║
-- ║ Las escribe /api/sismo-stats (Wikipedia → Gemini). Lectura pública.        ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

create table if not exists sismo_stats (
  id            uuid primary key default gen_random_uuid(),
  fallecidos    int,
  heridos       int,
  desaparecidos int,
  afectados     int,
  fecha         text,        -- fecha de actualización tal como la reporta la fuente
  fuente        text,        -- quién reporta (Asamblea Nacional / ONU / gobierno...)
  url           text,        -- enlace a la fuente
  updated_at    timestamptz default now()
);
create index if not exists idx_sismo_stats_upd on sismo_stats(updated_at desc);

alter table sismo_stats enable row level security;
-- Lectura pública (el banner la consume); escritura solo service_role (el endpoint).
drop policy if exists stats_read on sismo_stats;
create policy stats_read on sismo_stats for select using (true);
