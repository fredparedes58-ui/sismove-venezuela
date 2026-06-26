-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ SismoVE · Esquema Supabase                                                 ║
-- ║ Tablas _external = datos ingeridos por el scraper (patrón Krujens).        ║
-- ║ El dashboard lee con anon (solo SELECT); el webhook escribe con service.   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- ─── Personas desaparecidas (fuente: venezuelatebusca + otros portales) ──────
create table if not exists desaparecidos_external (
  external_id   text primary key,           -- "vtb:<id>"  (clave de upsert)
  source        text not null,
  nombre        text not null,
  cedula        text,
  edad          int,
  zona          text,
  estado        text default 'desaparecido', -- desaparecido | encontrado | ...
  encontrado    boolean default false,
  foto_url      text,
  notas         text,
  created_source timestamptz,                -- created_at en la fuente
  last_synced   timestamptz default now()
);
create index if not exists idx_desap_encontrado on desaparecidos_external(encontrado);
create index if not exists idx_desap_cedula on desaparecidos_external(cedula);

-- ─── Centros de acopio (fuente: centro-de-acopio-ven) ────────────────────────
create table if not exists centros_acopio_external (
  external_id   text primary key,           -- "acopio:<id>"
  source        text not null,
  nombre        text not null,
  direccion     text,
  telefono      text,
  lat           double precision,
  lng           double precision,
  necesita      jsonb default '[]'::jsonb,   -- artículos prioritarios que faltan
  sobra         jsonb default '[]'::jsonb,
  suministros   jsonb default '[]'::jsonb,
  verificaciones int default 0,
  created_source timestamptz,
  last_synced   timestamptz default now()
);

-- ─── Cola de notificaciones (push / Telegram broadcast) ──────────────────────
create table if not exists notification_queue (
  id         uuid primary key default gen_random_uuid(),
  type       text not null,                  -- persona_encontrada | nuevo_centro | centro_necesita | ...
  payload    jsonb,
  sent_at    timestamptz,
  created_at timestamptz default now()
);

-- ─── Observabilidad del scraper ──────────────────────────────────────────────
create table if not exists sync_runs (
  id      uuid primary key default gen_random_uuid(),
  source  text not null,
  ok      boolean,
  count   int,
  error   text,
  ran_at  timestamptz default now()
);

-- ─── Bot Telegram (patrón VITAS) ─────────────────────────────────────────────
create table if not exists bot_subscribers (
  chat_id     text primary key,
  username    text,
  zona        text,                          -- para notificaciones por zona (opcional)
  created_at  timestamptz default now(),
  unsubscribed_at timestamptz
);
create table if not exists telegram_messages (
  id         bigint generated always as identity primary key,
  chat_id    text not null,
  role       text not null,                  -- user | assistant
  content    text,
  created_at timestamptz default now()
);
create index if not exists idx_tg_msgs_chat on telegram_messages(chat_id, created_at desc);

-- ─── RLS ──────────────────────────────────────────────────────────────────
alter table desaparecidos_external   enable row level security;
alter table centros_acopio_external  enable row level security;
alter table notification_queue       enable row level security;
alter table sync_runs                enable row level security;
alter table bot_subscribers          enable row level security;
alter table telegram_messages        enable row level security;

-- Lectura pública SOLO de los datos agregados que muestra el dashboard
drop policy if exists p_read_desap on desaparecidos_external;
create policy p_read_desap  on desaparecidos_external  for select using (true);
drop policy if exists p_read_centros on centros_acopio_external;
create policy p_read_centros on centros_acopio_external for select using (true);
-- El resto de tablas: sin políticas anon → solo service_role (webhook/bot) accede.
