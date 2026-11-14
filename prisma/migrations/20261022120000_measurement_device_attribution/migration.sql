-- Atribución de mediciones a instancias de dispositivo (y al sensor del catálogo usado).
ALTER TABLE "measurements" ADD COLUMN "sensorDeviceId" UUID;
ALTER TABLE "measurements" ADD COLUMN "sensorId" VARCHAR(100);
ALTER TABLE "measurements" ADD COLUMN "channelSelectorDeviceId" UUID;

CREATE INDEX "idx_measurements_sensor_taken" ON "measurements"("sensorDeviceId", "sensorId", "takenAt" DESC);

ALTER TABLE "measurements" ADD CONSTRAINT "measurements_sensorDeviceId_fkey" FOREIGN KEY ("sensorDeviceId") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_channelSelectorDeviceId_fkey" FOREIGN KEY ("channelSelectorDeviceId") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
