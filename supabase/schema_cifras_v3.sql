-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ SismoVE · (v3) 3 bloques de cifras en la portada                           ║
-- ║  red = Red Ayuda Venezuela (EN VIVO, lo llena el cron desde /api/stats)     ║
-- ║  afe = Afectados por el Terremoto · Balance oficial (MANUAL; su web tiene    ║
-- ║        reCAPTCHA y no se puede auto-scrapear)                                ║
-- ║  dtv = Desaparecidos Terremoto Venezuela (manual, ya existe)                 ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

alter table cifras add column if not exists red jsonb;
alter table cifras add column if not exists afe jsonb;

-- Balance oficial de afectadosporelterremotovenezuela.com (manual; editar cuando cambie)
update cifras set afe = '{
  "fallecidos": 568, "heridos": 22567, "desaparecidos": 10876,
  "rescatados": "+1000", "familias": 43657, "edificaciones": "+3876",
  "updated": "26/06/2026 10:02 a.m."
}'::jsonb where id = 1;
