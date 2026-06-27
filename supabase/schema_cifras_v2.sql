-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ SismoVE · (v2) Marcadores manuales de Desaparecidos Terremoto + campo centro ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- Marcadores de desaparecidosterremotovenezuela.com (su API exige reCAPTCHA → NO se puede
-- auto-scrapear; se guardan a mano en este jsonb y se muestran con su enlace y fecha).
alter table cifras add column if not exists dtv jsonb;

insert into cifras (id, dtv) values (1, '{
  "desaparecidos": 92297, "sin_contacto": 55031, "localizados": 13022,
  "en_hospitales": 10511, "a_salvo": 9564, "heridos": 4500, "danos": 1073,
  "fallecidos": 920, "voluntarios": 482, "necesidades": 141, "atrapados": 104,
  "refugiados": null, "updated": "2026-06-27"
}'::jsonb)
on conflict (id) do update set dtv = excluded.dtv;

-- Ingresos hospitalarios: campo para el CENTRO donde se encuentra la persona (refugio/sede),
-- además del hospital. (La lista nueva del Drive trae hospital + centro.)
alter table hospital_admisiones add column if not exists centro text;
