-- IEEE 1876 (LaaS): sensor / selector de canal en vez de analyzer / mux; rangos y mediciones genéricos.

-- 1. Configuración de tarea
ALTER TABLE "task_preferences" RENAME COLUMN "analyzerDeviceId" TO "sensorDeviceId";
ALTER TABLE "task_preferences" RENAME COLUMN "muxDeviceId" TO "channelSelectorDeviceId";
ALTER TABLE "task_preferences" RENAME CONSTRAINT "task_preferences_analyzerDeviceId_fkey" TO "task_preferences_sensorDeviceId_fkey";
ALTER TABLE "task_preferences" RENAME CONSTRAINT "task_preferences_muxDeviceId_fkey" TO "task_preferences_channelSelectorDeviceId_fkey";

-- 2. Rangos
ALTER TABLE "task_preference_ranges" RENAME COLUMN "startFreq" TO "start";
ALTER TABLE "task_preference_ranges" RENAME COLUMN "stopFreq" TO "stop";
ALTER TABLE "task_preference_ranges" RENAME COLUMN "sweepType" TO "scale";

-- 3. Mediciones: copia genérica del barrido (NULL en lecturas puntuales) y de los dispositivos
ALTER TABLE "measurements" RENAME COLUMN "startFreq" TO "start";
ALTER TABLE "measurements" RENAME COLUMN "stopFreq" TO "stop";
ALTER TABLE "measurements" RENAME COLUMN "sweepType" TO "scale";
ALTER TABLE "measurements" ALTER COLUMN "start" DROP NOT NULL;
ALTER TABLE "measurements" ALTER COLUMN "stop" DROP NOT NULL;
ALTER TABLE "measurements" ALTER COLUMN "points" DROP NOT NULL;
ALTER TABLE "measurements" ALTER COLUMN "scale" DROP NOT NULL;
ALTER TABLE "measurements" RENAME COLUMN "analyzerName" TO "sensorDeviceName";
ALTER TABLE "measurements" RENAME COLUMN "analyzerIp" TO "sensorDeviceIp";
ALTER TABLE "measurements" ALTER COLUMN "sensorDeviceIp" DROP NOT NULL;
UPDATE "measurements" SET "sensorDeviceIp" = NULL WHERE "sensorDeviceIp" = '';
ALTER TABLE "measurements" RENAME COLUMN "muxName" TO "channelSelectorName";
ALTER TABLE "measurements" RENAME COLUMN "muxIp" TO "channelSelectorIp";
UPDATE "measurements" SET "channelSelectorIp" = NULL WHERE "channelSelectorIp" = '';

ALTER TABLE "measurements" ADD COLUMN "acquisition" JSONB;
UPDATE "measurements"
  SET "acquisition" = '{"kind":"sweep","variable":{"name":"frequency","unit":"Hz","label":"Frecuencia"}}'::jsonb;
ALTER TABLE "measurements" ALTER COLUMN "acquisition" SET NOT NULL;

-- 4. Puntos {frequency, values} → {x, values}; los legados {frequency, g, b} se dejan igual
UPDATE "measurements" m
SET "data" = (
  SELECT jsonb_agg(
           CASE WHEN e ? 'frequency' AND e ? 'values'
                THEN (e - 'frequency') || jsonb_build_object('x', e -> 'frequency')
                ELSE e END
           ORDER BY t.ord)
  FROM jsonb_array_elements(m."data") WITH ORDINALITY AS t(e, ord)
)
WHERE jsonb_typeof(m."data") = 'array' AND jsonb_array_length(m."data") > 0;
