import { Transform } from 'class-transformer';
import { IsEmail } from 'class-validator';

export class AddAdminDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsEmail({}, { message: 'Correo no válido' })
  email: string;
}
