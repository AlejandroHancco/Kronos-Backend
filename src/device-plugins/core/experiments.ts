import type { DeviceTypeCatalogEntry } from './device-plugin.registry';
import { ChannelRange, MeasurementValueMeta, channelRangeFor, valueMetasOf } from './experiment-config';

/**
 * Experimento con nombre (IEEE 1876 "getExperiment", nuestra lectura de la Tabla 20): un equipo de
 * medición y, opcionalmente, un selector de canal. Se deriva de los plugins registrados; no se persiste
 * (la preferencia guarda los dispositivos y el experimento se recalcula a partir de sus tipos).
 */
export interface ExperimentDefinition {
  experimentId: string;
  fullName: string;
  description: string;
  sensorType: string;
  channelSelectorType: string | null;
  channelRange: ChannelRange;
  sensorValues: MeasurementValueMeta[];
  simulated: boolean;
}

export const experimentIdOf = (sensorType: string, selectorType: string | null): string =>
  selectorType ? `${sensorType}+${selectorType}` : sensorType;

function definition(sensor: DeviceTypeCatalogEntry, selector: DeviceTypeCatalogEntry | null): ExperimentDefinition {
  const channelRange = channelRangeFor(selector?.service ?? null);
  return {
    experimentId: experimentIdOf(sensor.deviceType, selector?.deviceType ?? null),
    fullName: selector ? `${sensor.shortName} + ${selector.shortName}` : sensor.shortName,
    description: selector
      ? `${sensor.shortName} mide hasta ${channelRange.max} canales a través de ${selector.shortName}`
      : `${sensor.shortName} mide un único canal (conexión directa, canal 1)`,
    sensorType: sensor.deviceType,
    channelSelectorType: selector?.deviceType ?? null,
    channelRange,
    sensorValues: valueMetasOf(sensor.service),
    simulated: sensor.simulated,
  };
}

/** Por cada sensor (en orden de registro): primero sensor + cada selector, luego el sensor solo. */
export function experimentCatalog(entries: DeviceTypeCatalogEntry[]): ExperimentDefinition[] {
  const selectors = entries.filter((e) => e.role === 'channel-selector');
  return entries
    .filter((e) => e.role === 'sensor')
    .flatMap((s) => [...selectors.map((sel) => definition(s, sel)), definition(s, null)]);
}

/** Experimento de una combinación de tipos; `null` si no es un sensor (+ selector) registrado. */
export function experimentFor(
  entries: DeviceTypeCatalogEntry[],
  sensorType: string | null | undefined,
  selectorType: string | null | undefined,
): ExperimentDefinition | null {
  const sensor = entries.find((e) => e.deviceType === sensorType && e.role === 'sensor');
  if (!sensor) return null;
  if (!selectorType) return definition(sensor, null);
  const selector = entries.find((e) => e.deviceType === selectorType && e.role === 'channel-selector');
  return selector ? definition(sensor, selector) : null;
}
