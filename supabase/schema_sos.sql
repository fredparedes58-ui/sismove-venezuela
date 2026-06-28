-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ SismoVE · SOS en sitio — la gente pide rescate y marca dónde está atrapada.  ║
-- ║  Botón SOS → ubicación (GPS o manual) + nota → marcador en el mapa para        ║
-- ║  rescatistas/voluntarios. RLS: lectura e inserción anónimas; borrado solo admin.║
-- ╚══════════════════════════════════════════════════════════════════════════╝

create table if not exists sos_reports (
  id          uuid primary key default gen_random_uuid(),
  lat         double precision,
  lng         double precision,
  ciudad      text,
  direccion   text,
  nota        text,
  contacto    text,
  personas    integer,
  estado      text default 'activo',   -- activo | atendido
  foto_url    text,
  fotos       jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists sos_created_idx on sos_reports (created_at desc);

alter table sos_reports enable row level security;
drop policy if exists "sos public read" on sos_reports;
create policy "sos public read" on sos_reports for select to anon, authenticated using (true);
drop policy if exists "sos anon insert" on sos_reports;
create policy "sos anon insert" on sos_reports for insert to anon, authenticated with check (true);
-- sin update/delete para anon: el borrado/edición es solo admin (service_role).
