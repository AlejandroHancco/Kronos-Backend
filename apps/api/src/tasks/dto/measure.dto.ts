import { IsIn, IsInt, IsOptional, IsString, IsArray, Min, Max, IsNumber, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { IsGreaterThan } from '@app/common';

/** Un rango de barrido sobre la variable que declara el sensor (límites por dispositivo: B3). */
export class SweepRangeDto {
  @IsNumber()
  start: number;

  @IsNumber()
  @IsGreaterThan('start', { message: 'stop debe ser mayor que start' })
  stop: number;

  @IsInt()
  @Min(1)
  points: number;

  @IsIn(['LIN', 'LOG'])
  scale: 'LIN' | 'LOG';
}

export class MeasureDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SweepRangeDto)
  ranges: SweepRangeDto[];

  @IsArray()
  @IsNumber({}, { each: true })
  @Min(1, { each: true })
  @Max(16, { each: true })
  selectedChannels: number[];

  @IsOptional()
  @IsString()
  jobId?: string;
}
