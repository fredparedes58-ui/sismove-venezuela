-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ SismoVE · Logística / Necesidades por zona (coordinación de reparto)        ║
-- ║ Voluntarios marcan dónde FALTA ayuda o qué zona ya está cubierta/saturada. ║
-- ║ Igual que los otros reportes: cualquiera LEE e INSERTA (no edita/borra).    ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

create table if not exists logistica_reports (
  id         uuid primary key default gen_random_uuid(),
  lat        double precision not null,
  lng        double precision not null,
  ciudad     text,
  tipo       text,                       -- comida | agua | medicinas | higiene | ropa | voluntarios | otro
  estado     text default 'falta',       -- falta (🔴 hace falta) | cubierto (🟢 ya cubierto/saturado)
  nota       text,                       -- detalle corto (ej: "parque con 50 niños, falta cena")
  created_at timestamptz default now()
);
create index if not exists idx_logi_created on logistica_reports(created_at desc);

alter table logistica_reports enable row level security;
drop policy if exists logi_read   on logistica_reports;
drop policy if exists logi_insert on logistica_reports;
create policy logi_read   on logistica_reports for select using (true);
create policy logi_insert on logistica_reports for insert with check (true);
