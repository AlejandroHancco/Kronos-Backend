import type { PrismaService } from '@app/database';
import type { AcquisitionSnapshot } from '@app/laas-catalog';
import { parseSensorValues, storedPointsOf, type MeasurementValueMeta, type StoredMeasurementPoint } from './measurement-data';

export interface SingleReading { data: StoredMeasurementPoint[]; sensorValues: MeasurementValueMeta[] }

/**
 * Punto y valores declarados de las lecturas puntuales de una lista, en UNA consulta acotada a
 * sus ids: las listas no cargan `data` (los barridos pueden tener miles de puntos) y solo las
 * lecturas puntuales (un punto, chico) lo exponen. Sin lecturas puntuales no consulta.
 */
export async function loadSingleReadings(
  prisma: Pick<PrismaService, 'measurement'>,
  rows: { id: number; acquisition: AcquisitionSnapshot }[],
): Promise<Map<number, SingleReading>> {
  const ids = rows.filter((r) => r.acquisition.kind === 'single').map((r) => r.id);
  if (ids.length === 0) return new Map();
  const found = await prisma.measurement.findMany({
    where: { id: { in: ids } },
    select: { id: true, data: true, sensorValues: true },
  });
  return new Map(found.map((f) => [f.id, { data: storedPointsOf(f.data), sensorValues: parseSensorValues(f.sensorValues) }]));
}

/** Campos extra de un elemento de lista: `data` y `sensorValues` solo en lecturas puntuales. */
export function singleReadingFields(readings: Map<number, SingleReading>, id: number, acquisition: AcquisitionSnapshot): Partial<SingleReading> {
  if (acquisition.kind !== 'single') return {};
  return readings.get(id) ?? { data: [], sensorValues: [] };
}
