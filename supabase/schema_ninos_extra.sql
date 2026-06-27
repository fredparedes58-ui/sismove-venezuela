-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ SismoVE · Reportes de personas: quién encontró + documento adjunto          ║
-- ║  + policy para permitir SUBIR archivos (fotos/PDF) al bucket 'reportes'.     ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

alter table desaparecidos_reportes add column if not exists encontrado_por text;   -- quién lo encontró/reportó
alter table desaparecidos_reportes add column if not exists documento_url  text;   -- foto/PDF de documento o constancia

-- Permitir que la gente (anon) suba archivos al bucket público 'reportes'
-- (limitado por el bucket a imágenes/PDF y 10 MB). La lectura ya es pública.
drop policy if exists "anon insert reportes" on storage.objects;
create policy "anon insert reportes" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'reportes');
