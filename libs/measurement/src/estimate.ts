import { estimateAcquisitionSeconds, type AcquisitionMetadata } from '@app/laas-catalog';

/**
 * Estimación aditiva de duración (segundos): canales × (cambio de canal + Σ rangos(setup + puntos·t)),
 * según la adquisición que declara el dispositivo de medición (ver acquisition.ts del catálogo).
 */
export function estimateSeconds(
  acquisition: AcquisitionMetadata,
  ranges: { points: number }[],
  channelCount: number,
  hasSelector: boolean,
): number {
  return estimateAcquisitionSeconds(acquisition, ranges, channelCount, hasSelector);
}
