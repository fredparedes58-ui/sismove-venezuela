-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ SismoVE · Migración para el lector UNIVERSAL del Drive (api/sync-drive)     ║
-- ║ Añade ext_id (clave estable por fila), source (origen) y updated_at (lote)  ║
-- ║ a las tablas que pueden recibir archivos. Idempotente. Correr una vez.      ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- desaparecidos_reportes (ext_id y source ya vienen de schema_desaparecidos_sync.sql)
alter table desaparecidos_reportes add column if not exists updated_at timestamptz default now();
alter table desaparecidos_reportes add column if not exists categoria  text;   -- 'nino' = apartado de niños; null = general
create index if not exists idx_desap_rep_categoria on desaparecidos_reportes(categoria);

-- zona_reports — necesita clave estable + sello de lote para espejar el archivo sin duplicar
alter table zona_reports add column if not exists ext_id     text;
alter table zona_reports add column if not exists source     text;   -- 'drive:<archivo>' = vino de un archivo; null = reporte del mapa
alter table zona_reports add column if not exists updated_at timestamptz default now();
create unique index if not exists idx_zona_extid on zona_reports(ext_id);

-- logistica_reports — igual
alter table logistica_reports add column if not exists ext_id     text;
alter table logistica_reports add column if not exists source     text;
alter table logistica_reports add column if not exists updated_at timestamptz default now();
create unique index if not exists idx_logi_extid on logistica_reports(ext_id);

-- centros_acopio_external ya tiene external_id (PK), source y last_synced → no requiere cambios.
-- hospital_admisiones ya tiene id (PK), source y updated_at → no requiere cambios.
