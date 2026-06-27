-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ SismoVE · Fotos en los reportes del mapa                                   ║
-- ║ Añade columna foto_url a los reportes comunitarios + permite subir al      ║
-- ║ bucket 'reportes' (ya creado, público). Lectura pública por bucket.        ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

alter table coverage_reports  add column if not exists foto_url text;
alter table power_reports     add column if not exists foto_url text;
alter table zona_reports      add column if not exists foto_url text;
alter table logistica_reports add column if not exists foto_url text;

-- Permitir que cualquiera (anon) SUBA imágenes SOLO al bucket 'reportes'.
-- (La lectura ya es pública porque el bucket es público.)
drop policy if exists "anon sube a reportes" on storage.objects;
create policy "anon sube a reportes" on storage.objects
  for insert to anon with check (bucket_id = 'reportes');
