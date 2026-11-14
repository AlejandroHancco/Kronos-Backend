import { IsString, IsNotEmpty, IsOptional, IsIP, IsInt, Min, Max } from 'class-validator';

export class TestConnectionDto {
  @IsString()
  @IsNotEmpty()
  type: string;

  /** Opcional: los tipos sin dirección (catálogo connection.requiresIp === false) no la usan. */
  @IsOptional()
  @IsIP(undefined, { message: 'ip debe ser una dirección IP válida' })
  ip?: string;

  @IsOptional()
  @IsInt({ message: 'port debe ser un entero' })
  @Min(1, { message: 'port debe estar entre 1 y 65535' })
  @Max(65535, { message: 'port debe estar entre 1 y 65535' })
  port?: number;
}
