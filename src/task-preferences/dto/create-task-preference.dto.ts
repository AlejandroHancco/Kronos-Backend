import {
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { IsGreaterThan } from '../../common/validators/is-greater-than.decorator';

export class TaskPreferenceRangeDto {
  @IsInt()
  @Min(0)
  order: number;

  @IsNumber()
  start: number;

  @IsNumber()
  @IsGreaterThan('start', { message: 'stop debe ser mayor que start' })
  stop: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  points?: number;

  @IsOptional()
  @IsIn(['LOG', 'LIN'])
  scale?: string;
}

export class CreateTaskPreferenceDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @IsUUID()
  sensorDeviceId: string;

  @IsOptional()
  @IsUUID()
  channelSelectorDeviceId?: string | null;

  /** Puede venir vacío (lecturas puntuales); la validación por sensor es de B3. */
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TaskPreferenceRangeDto)
  ranges: TaskPreferenceRangeDto[];
}
