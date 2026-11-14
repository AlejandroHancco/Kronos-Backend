import type { AcquisitionSnapshot } from '../../device-plugins/core/acquisition';

export class MeasurementResponseDto {
  id: number;
  takenAt: Date;
  takenBy: string;
  /** Copia del barrido; null en lecturas puntuales. */
  start: number | null;
  stop: number | null;
  sensorDeviceName: string;
  channelSelectorName: string | null;
  acquisition: AcquisitionSnapshot;
}
