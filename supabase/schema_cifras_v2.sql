-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ SismoVE · (v2) Marcadores manuales de Desaparecidos Terremoto + campo centro ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- Marcadores de desaparecidosterremotovenezuela.com (su API exige reCAPTCHA → NO se puede
-- auto-scrapear; se guardan a mano en este jsonb y se muestran con su enlace y fecha).
alter table cifras add column if not exists dtv jsonb;

-- 4 marcadores de desaparecidosterremotovenezuela.com (manual; su web tiene reCAPTCHA).
insert into cifras (id, dtv) values (1, '{
  "reportes": 77922, "personas_unicas": 69227, "sin_contacto": 55465,
  "localizados": 13762, "updated": "2026-06-27"
}'::jsonb)
on conflict (id) do update set dtv = excluded.dtv;

-- Ingresos hospitalarios: campo para el CENTRO donde se encuentra la persona (refugio/sede),
-- además del hospital. (La lista nueva del Drive trae hospital + centro.)
alter table hospital_admisiones add column if not exists centro text;
