import type { StoredMeasurementPoint } from '@app/laas-catalog';

export type MeasurementSeverity = 'correct' | 'warning' | 'error';

export interface MeasurementClassification {
  severity: MeasurementSeverity;
  reason?: string;
  /** true: `reason` debe mostrarse tal cual, sin agregarle contexto de proyecto/dispositivos. */
  bare?: boolean;
}

/** Valor absoluto por debajo del cual una lectura se considera nula. */
const ZERO_EPSILON = 1e-9;

/** % de lecturas nulas a partir del cual se clasifica como error (sensor desconectado / sin señal real). */
const ERROR_ZERO_RATIO = 0.8;

/** % de lecturas nulas a partir del cual se clasifica como warning (posible problema, no concluyente). */
const WARNING_ZERO_RATIO = 0.3;

/**
 * Kronos Watcher — módulo de verificación de mediciones de la plataforma.
 *
 * Clasifica correct/warning/error según qué tan "nulos" vienen los valores de los
 * sensorValues indicados en `valueKeys` — las claves que declara el plugin del
 * equipo de medición en su descripción (IEEE 1876, `sensorValues`). Es agnóstico al
 * dispositivo: la adquisición se resuelve por plugin (ver device-plugins/) y aquí
 * solo se inspeccionan las claves de `point.values` declaradas.
 * Solo revisa los canales efectivamente medidos — los demás slots del array de
 * 16 quedan en 0 por diseño y no son una anomalía. Agnóstico también a la forma
 * de la adquisición: recorre los puntos sin leer `x`, así que sirve igual para
 * puntos de barrido o una lectura puntual.
 */
export function classifyMeasurement(
  measurementData: StoredMeasurementPoint[],
  measuredChannels: number[],
  valueKeys: string[],
): MeasurementClassification {
  if (measurementData.length === 0 || measuredChannels.length === 0) {
    return { severity: 'error', reason: 'No se recibieron datos de medición', bare: true };
  }
  if (valueKeys.length === 0) return { severity: 'error', reason: 'El dispositivo no declara valores de sensor', bare: true };

  let total = 0;
  let nearZero = 0;

  for (const point of measurementData) {
    for (const channel of measuredChannels) {
      const idx = channel - 1;
      for (const key of valueKeys) {
        const arr = point.values?.[key];
        const value = Array.isArray(arr) ? (arr[idx] ?? 0) : 0;
        total += 1;
        if (Math.abs(value) < ZERO_EPSILON) nearZero++;
      }
    }
  }

  const zeroRatio = total === 0 ? 1 : nearZero / total;
  const zeroPercent = Math.round(zeroRatio * 100);

  if (zeroRatio >= ERROR_ZERO_RATIO) {
    return {
      severity: 'error',
      reason: `Valores nulos: ${zeroPercent}% de las lecturas son cero o casi cero`,
    };
  }
  if (zeroRatio >= WARNING_ZERO_RATIO) {
    return {
      severity: 'warning',
      reason: `Posibles valores nulos: ${zeroPercent}% de las lecturas son cero o casi cero`,
    };
  }
  return { severity: 'correct' };
}
