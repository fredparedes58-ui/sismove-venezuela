-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ SismoVE · Cobertura y Luz como destinos de Google Drive                      ║
-- ║  Da a coverage_reports / power_reports las columnas que usa el lector de       ║
-- ║  Drive (ext_id único, source, updated_at) para upsert + espejo, igual que      ║
-- ║  zona/logistica. Más foto_url/direccion/descripcion. Todo nullable.            ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

do $$
declare t text;
begin
  foreach t in array array['coverage_reports','power_reports']
  loop
    execute format('alter table %I add column if not exists ext_id      text',        t);
    execute format('alter table %I add column if not exists source      text',        t);
    execute format('alter table %I add column if not exists updated_at  timestamptz', t);
    execute format('alter table %I add column if not exists foto_url    text',        t);
    execute format('alter table %I add column if not exists direccion   text',        t);
    execute format('alter table %I add column if not exists referencia  text',        t);
    execute format('alter table %I add column if not exists descripcion text',        t);
    execute format('alter table %I add column if not exists fotos       jsonb',       t);
    -- índice único para el upsert on_conflict=ext_id (los NULL de filas viejas no chocan)
    execute format('create unique index if not exists %I on %I (ext_id)', t || '_ext_id_uidx', t);
  end loop;
end $$;
