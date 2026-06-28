-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ SismoVE · Fix: columna foto_url faltante en las tablas de reportes del mapa   ║
-- ║  (la migración de fotos no se había aplicado a estas tablas). Nullable.        ║
-- ║  OPCIONAL: la app ya guarda sin esto (reintenta sin la columna), pero correrlo ║
-- ║  deja el esquema correcto, evita el reintento y guarda la foto principal.       ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

do $$
declare t text;
begin
  foreach t in array array['coverage_reports','power_reports','zona_reports','logistica_reports']
  loop
    execute format('alter table %I add column if not exists foto_url text', t);
  end loop;
end $$;
