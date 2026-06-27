-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ SismoVE · Ampliación de formularios de reporte (28-jun)                      ║
-- ║  Dirección/referencia/descripción + fotos múltiples + ubicación (lat/lng)    ║
-- ║  + tipo de persona (niño/adulto). Todo NULLABLE → retrocompatible.           ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- 1) Personas desaparecidas: tipo niño/adulto, referencia, fotos (varias), ubicación.
--    La "descripción/detalles" sigue guardándose en la columna `nota` ya existente.
alter table desaparecidos_reportes add column if not exists tipo_persona text;          -- 'nino' | 'adulto'
alter table desaparecidos_reportes add column if not exists referencia   text;          -- punto de referencia
alter table desaparecidos_reportes add column if not exists fotos         jsonb;         -- ["url1","url2",...]
alter table desaparecidos_reportes add column if not exists lat           double precision;
alter table desaparecidos_reportes add column if not exists lng           double precision;

-- Retrocompat: deriva tipo_persona de la categoría ya existente (categoria='nino').
-- (garantiza que la columna categoria exista, por si esta migración corre antes que schema_drive_sync.sql)
alter table desaparecidos_reportes add column if not exists categoria text;
update desaparecidos_reportes
   set tipo_persona = case when categoria = 'nino' then 'nino' else 'adulto' end
 where tipo_persona is null;

-- 2) Reportes comunitarios del mapa: dirección, referencia, descripción y fotos.
--    (la foto principal sigue en `foto_url`; `fotos` guarda todas las URLs.)
do $$
declare t text;
begin
  foreach t in array array['coverage_reports','power_reports','zona_reports','logistica_reports']
  loop
    execute format('alter table %I add column if not exists direccion   text',  t);
    execute format('alter table %I add column if not exists referencia  text',  t);
    execute format('alter table %I add column if not exists descripcion text',  t);
    execute format('alter table %I add column if not exists fotos       jsonb', t);
  end loop;
end $$;
