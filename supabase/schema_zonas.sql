-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ SismoVE · Reportes comunitarios de ZONAS AFECTADAS (daños marcados por la  ║
-- ║ gente). Ejecuta esto en Supabase → SQL Editor (complementa schema_reports).║
-- ║ Igual que cobertura/luz: cualquiera puede LEER e INSERTAR (no editar/borrar)║
-- ╚══════════════════════════════════════════════════════════════════════════╝

create table if not exists zona_reports (
  id         uuid primary key default gen_random_uuid(),
  lat        double precision not null,
  lng        double precision not null,
  ciudad     text,
  tipo       text,                       -- colapso | grietas | inundacion | via | incendio | otro
  created_at timestamptz default now()
);
create index if not exists idx_zona_created on zona_reports(created_at desc);

-- ─── RLS: data comunitaria pública (anon puede LEER e INSERTAR; no editar/borrar) ───
alter table zona_reports enable row level security;

drop policy if exists zona_read   on zona_reports;
drop policy if exists zona_insert on zona_reports;
create policy zona_read   on zona_reports for select using (true);
create policy zona_insert on zona_reports for insert with check (true);
