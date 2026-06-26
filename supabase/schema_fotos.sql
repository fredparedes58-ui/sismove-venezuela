-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ SismoVE · Control de OCR de fotos (auto-OCR de imágenes nuevas del Drive)  ║
-- ║ Ejecuta en Supabase → SQL Editor. Registra qué fotos ya se procesaron.     ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

create table if not exists foto_ocr (
  file_id   text primary key,    -- id del archivo en Google Drive
  hospital  text,
  names     int default 0,       -- nº de nombres extraídos
  ocr_at    timestamptz default now()
);

alter table foto_ocr enable row level security;
-- Sin políticas anon: solo el service_role (el endpoint) lee/escribe.
