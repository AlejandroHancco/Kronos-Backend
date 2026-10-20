import { IsString, IsNotEmpty, IsOptional, IsNumber } from 'class-validator';

export class TestConnectionDto {
  @IsString()
  @IsNotEmpty()
  type: string;

  @IsOptional()
  @IsString()
  ip?: string;

  @IsOptional()
  @IsNumber()
  port?: number;
}
