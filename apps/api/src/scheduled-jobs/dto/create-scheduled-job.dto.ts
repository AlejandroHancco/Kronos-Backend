import { IsString, IsOptional, IsISO8601, IsArray, Min, IsInt, Max } from 'class-validator';

export class CreateScheduledJobDto {
  @IsInt()
  taskId: number;

  @IsOptional()
  @IsString()
  label?: string;

  @IsISO8601()
  startAt: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  intervalMinutes?: number;

  @IsInt()
  @Min(1)
  repeatCount: number;

  /** Minutos de retraso tolerados antes de dar la ejecución por perdida (por defecto 5). */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(30)
  toleranceMinutes?: number;

  @IsArray()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(16, { each: true })
  channelNumbers: number[];
}
