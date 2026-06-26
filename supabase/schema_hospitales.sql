-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ SismoVE · Ingresos hospitalarios (desde los Docs del Google Drive)         ║
-- ║ Ejecuta en Supabase → SQL Editor. SIN cédula (se redacta en el sync).      ║
-- ║ Búsqueda pública por nombre para que las familias localicen a sus heridos. ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

create table if not exists hospital_admisiones (
  id          text primary key,        -- "nombre|hospital" normalizado (dedupe)
  nombre      text not null,
  hospital    text,
  fecha       text,
  source      text,                     -- nombre del documento de origen
  updated_at  timestamptz default now()
);
create index if not exists idx_hosp_nombre on hospital_admisiones (lower(nombre));

alter table hospital_admisiones enable row level security;
-- Lectura pública (familias buscan); escritura solo service_role (el sync). NO se guarda cédula.
drop policy if exists hosp_read on hospital_admisiones;
create policy hosp_read on hospital_admisiones for select using (true);
