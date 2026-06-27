-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ SismoVE · Grupos / canales comunitarios por zona y edificio                 ║
-- ║  Directorio que la gente puede AGREGAR: grupos de WhatsApp/Telegram donde    ║
-- ║  se comparte información y situaciones por sector y por edificio (como los    ║
-- ║  "Grupos de WhatsApp La Guaira": Caraballeda, Playa Grande, Edf Oasis, etc.) ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

create table if not exists grupos_comunitarios (
  id          uuid primary key default gen_random_uuid(),
  nombre      text not null,                 -- nombre del grupo/edificio/zona (ej: "Edf Oasis")
  tipo        text not null default 'edificio', -- edificio | zona | accion | otro
  zona        text,                          -- sector/ciudad para agrupar (ej: "Caraballeda, La Guaira")
  url         text,                          -- enlace de WhatsApp/Telegram (wa.me, chat.whatsapp.com, t.me…)
  contacto    text,                          -- teléfono o contacto (opcional)
  nota        text,                          -- qué se comparte / situación
  created_at  timestamptz not null default now()
);

create index if not exists grupos_zona_idx on grupos_comunitarios (zona);
create index if not exists grupos_created_idx on grupos_comunitarios (created_at desc);

alter table grupos_comunitarios enable row level security;

-- Cualquiera puede LEER el directorio
drop policy if exists "grupos public read" on grupos_comunitarios;
create policy "grupos public read" on grupos_comunitarios
  for select to anon, authenticated using (true);

-- Cualquiera puede AGREGAR un grupo (sin update/delete: el borrado es solo admin vía service_role)
drop policy if exists "grupos anon insert" on grupos_comunitarios;
create policy "grupos anon insert" on grupos_comunitarios
  for insert to anon, authenticated with check (true);
