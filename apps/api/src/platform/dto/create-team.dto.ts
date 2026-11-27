import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateTeamDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'El nombre es obligatorio' })
  @MaxLength(100, { message: 'El nombre admite como máximo 100 caracteres' })
  @Matches(/^[^\r\n]+$/, { message: 'El nombre no puede contener saltos de línea' })
  name: string;

  // Los códigos se guardan en mayúsculas (el ingreso con /teams/join también los normaliza).
  @Transform(({ value }) =>
    typeof value === 'string' ? (value.trim() === '' ? undefined : value.trim().toUpperCase()) : value,
  )
  @IsOptional()
  @IsString()
  @Length(4, 20, { message: 'El código debe tener entre 4 y 20 caracteres' })
  @Matches(/^[A-Za-z0-9-]+$/, { message: 'El código solo admite letras, números y guiones' })
  code?: string;

  @Transform(trim)
  @IsEmail({}, { message: 'Correo del administrador no válido' })
  adminEmail: string;
}
