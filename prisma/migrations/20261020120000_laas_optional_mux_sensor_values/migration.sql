-- MUX opcional en la configuración del experimento
ALTER TABLE "task_preferences" ALTER COLUMN "muxDeviceId" DROP NOT NULL;
-- Snapshot de MUX opcional en cada medición
ALTER TABLE "measurements" ALTER COLUMN "muxName" DROP NOT NULL;
ALTER TABLE "measurements" ALTER COLUMN "muxIp" DROP NOT NULL;
-- Metadata de los valores declarados por el plugin al momento de medir
ALTER TABLE "measurements" ADD COLUMN "sensorValues" JSONB;
