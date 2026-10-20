import { IsArray, IsNumber, IsUUID, IsString, IsOptional } from 'class-validator';
import type { MeasurementValueMeta } from '../measurement-data';

export class CreateMeasurementDto {
  @IsNumber()
  taskId: number;

  @IsUUID()
  takenBy: string;

  @IsOptional()
  @IsString()
  presetName?: string;

  @IsNumber()
  startFreq: number;

  @IsNumber()
  stopFreq: number;

  @IsNumber()
  points: number;

  @IsString()
  sweepType: string;

  @IsString()
  analyzerName: string;

  @IsString()
  analyzerIp: string;

  @IsOptional()
  @IsString()
  muxName?: string;

  @IsOptional()
  @IsString()
  muxIp?: string;

  @IsArray()
  data: unknown[]; // JSONB: StoredMeasurementPoint[]

  @IsOptional()
  @IsArray()
  sensorValues?: MeasurementValueMeta[];
}
