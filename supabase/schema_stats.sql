-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ SismoVE · Cifras del terremoto por fuente (banner rojo)                    ║
-- ║ Las escribe /api/sismo-stats (scraping de Vozpópuli, OKDIARIO y            ║
-- ║ afectadosporelterremotovenezuela.com + extracción con Gemini).            ║
-- ║ `sources` = array JSON, cada item con su fuente y cifras. Lectura pública. ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

create table if not exists sismo_stats (
  id          uuid primary key default gen_random_uuid(),
  sources     jsonb default '[]'::jsonb,   -- [{nombre,url,fallecidos,heridos,desaparecidos,rescatados,aparecidos,fecha}]
  updated_at  timestamptz default now()
);
create index if not exists idx_sismo_stats_upd on sismo_stats(updated_at desc);

alter table sismo_stats enable row level security;
-- Lectura pública (el banner la consume); escritura solo service_role (el endpoint).
drop policy if exists stats_read on sismo_stats;
create policy stats_read on sismo_stats for select using (true);
