-- Tipos de dispositivo = id del modelo (plugin)
UPDATE "devices" SET "type" = 'hioki-im3570' WHERE "type" = 'analyzer';
UPDATE "devices" SET "type" = 'kronos-mux-16' WHERE "type" = 'mux';
-- Configuración persistida por dispositivo (setConfiguration); NULL = valores por defecto del plugin
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "configuration" JSONB;
