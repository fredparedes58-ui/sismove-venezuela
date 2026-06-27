-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ SismoVE · Migración para sincronizar desaparecidos desde Google Drive      ║
-- ║ Añade ext_id (clave estable por fila del archivo) y source ('drive'/null). ║
-- ║ Correr DESPUÉS de schema_desaparecidos.sql. Es idempotente.                ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- Clave determinista por fila del archivo del Drive → permite re-sincronizar sin duplicar.
-- Los reportes hechos desde la app dejan ext_id NULL (Postgres permite múltiples NULL en un
-- índice único), así que el sync NUNCA pisa ni borra lo que reporta la gente.
alter table desaparecidos_reportes add column if not exists ext_id text;
alter table desaparecidos_reportes add column if not exists source text;   -- 'drive' = lista oficial; null = reporte de la app
create unique index if not exists idx_desap_rep_extid on desaparecidos_reportes(ext_id);
