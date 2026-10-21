import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsNumber, IsObject, IsUUID, IsString, IsOptional } from 'class-validator';
import { MAX_POSTED_POINTS, type MeasurementValueMeta } from '../measurement-data';
import type { AcquisitionSnapshot } from '../../device-plugins/core/acquisition';

export class CreateMeasurementDto {
  @IsNumber()
  taskId: number;

  @IsUUID()
  takenBy: string;

  @IsOptional()
  @IsString()
  presetName?: string;

  @IsOptional()
  @IsNumber()
  start?: number;

  @IsOptional()
  @IsNumber()
  stop?: number;

  @IsOptional()
  @IsNumber()
  points?: number;

  @IsOptional()
  @IsString()
  scale?: string;

  @IsString()
  sensorDeviceName: string;

  @IsOptional()
  @IsString()
  sensorDeviceIp?: string;

  @IsOptional()
  @IsString()
  channelSelectorName?: string;

  @IsOptional()
  @IsString()
  channelSelectorIp?: string;

  /** JSONB: StoredMeasurementPoint[]; contenido validado por postedMeasurementError (measurement-data.ts). */
  @IsArray({ message: 'data debe ser un arreglo de puntos { x, values }' })
  @ArrayMaxSize(MAX_POSTED_POINTS, { message: `data admite como máximo ${MAX_POSTED_POINTS} puntos` })
  data: unknown[];

  /** Valores de sensor declarados ({name, unit, label?}); obligatorio y no vacío. */
  @IsArray({ message: 'sensorValues es obligatorio y debe ser un arreglo de { name, unit, label? }' })
  @ArrayNotEmpty({ message: 'sensorValues debe declarar al menos un valor' })
  sensorValues: MeasurementValueMeta[];

  /** Snapshot de adquisición ({ kind: 'sweep', variable } o { kind: 'single' }); ausente → barrido en frecuencia. */
  @IsOptional()
  @IsObject()
  acquisition?: AcquisitionSnapshot;
}
