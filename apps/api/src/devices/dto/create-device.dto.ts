import { IsString, IsOptional, IsNotEmpty, IsIP, MaxLength } from 'class-validator';

export class CreateDeviceDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  name: string;

  /** Validado contra el catálogo de plugins en DevicesService. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  type: string;

  @IsIP()
  @IsOptional()
  ip?: string;
}
