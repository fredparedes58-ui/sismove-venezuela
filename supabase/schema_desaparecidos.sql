-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ SismoVE · Registro PROPIO de personas desaparecidas (reportar + buscar)    ║
-- ║ La gente publica a quien busca (con foto). Buscable en la app y el bot.    ║
-- ║ Cualquiera LEE e INSERTA (es difusión); borrar = solo admin (endpoint).    ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

create table if not exists desaparecidos_reportes (
  id         uuid primary key default gen_random_uuid(),
  nombre     text not null,
  edad       text,
  zona       text,                       -- ciudad/estado
  visto      text,                       -- dónde/cuándo se le vio por última vez
  contacto   text,                       -- teléfono de quien busca (opcional)
  nota       text,
  foto_url   text,
  estado     text default 'buscando',    -- buscando | encontrado
  created_at timestamptz default now()
);
create index if not exists idx_desap_rep_created on desaparecidos_reportes(created_at desc);
create index if not exists idx_desap_rep_nombre  on desaparecidos_reportes(nombre);

alter table desaparecidos_reportes enable row level security;
drop policy if exists desaprep_read   on desaparecidos_reportes;
drop policy if exists desaprep_insert on desaparecidos_reportes;
create policy desaprep_read   on desaparecidos_reportes for select using (true);
create policy desaprep_insert on desaparecidos_reportes for insert with check (true);
