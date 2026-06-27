-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ SismoVE · Cifras de la portada + campos extra del formulario de reporte     ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- Marcadores de la portada (1 sola fila, id=1). El cron la refresca cada 30 min.
create table if not exists cifras (
  id            int primary key default 1,
  desaparecidos int,
  localizados   int,
  total         int,
  fallecidos    int,
  heridos       int,
  updated_at    timestamptz default now()
);
alter table cifras enable row level security;
drop policy if exists cifras_read on cifras;
create policy cifras_read on cifras for select using (true);   -- lectura pública (portada)
-- (escritura solo vía service_role en el endpoint /api/cifras; sin policy de insert/update para anon)

-- Formulario de reporte: permitir cédula y dirección (entrada MANUAL por familiares).
alter table desaparecidos_reportes add column if not exists cedula    text;
alter table desaparecidos_reportes add column if not exists direccion text;
