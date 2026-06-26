-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ SismoVE · Tablas de reportes comunitarios (cobertura móvil y estado luz)   ║
-- ║ Ejecuta esto en Supabase → SQL Editor (complementa a schema.sql).          ║
-- ║ Permiten que los reportes del mapa se compartan entre TODOS los usuarios.  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

create table if not exists coverage_reports (
  id         uuid primary key default gen_random_uuid(),
  lat        double precision not null,
  lng        double precision not null,
  ciudad     text,
  operador   text,                       -- Movistar | Digitel | Movilnet | Otra
  estado     text not null,              -- senal | intermitente | sinsenal
  created_at timestamptz default now()
);
create index if not exists idx_cov_created on coverage_reports(created_at desc);

create table if not exists power_reports (
  id         uuid primary key default gen_random_uuid(),
  lat        double precision not null,
  lng        double precision not null,
  ciudad     text,
  estado     text not null,              -- conluz | sinluz
  created_at timestamptz default now()
);
create index if not exists idx_pow_created on power_reports(created_at desc);

-- ─── RLS: data comunitaria pública (anon puede LEER e INSERTAR; no editar/borrar) ───
alter table coverage_reports enable row level security;
alter table power_reports    enable row level security;

drop policy if exists cov_read   on coverage_reports;
drop policy if exists cov_insert on coverage_reports;
create policy cov_read   on coverage_reports for select using (true);
create policy cov_insert on coverage_reports for insert with check (true);

drop policy if exists pow_read   on power_reports;
drop policy if exists pow_insert on power_reports;
create policy pow_read   on power_reports for select using (true);
create policy pow_insert on power_reports for insert with check (true);
