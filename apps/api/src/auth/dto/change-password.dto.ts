import { IsString, MinLength } from 'class-validator';

export class ChangePasswordDto {
  @IsString()
  currentPassword: string;

  // El límite real de bcrypt es 72 BYTES UTF-8 (no caracteres); se valida en
  // AuthService.changePassword, donde Buffer.byteLength puede medirlo correctamente.
  @IsString()
  @MinLength(8, { message: 'La nueva contraseña debe tener al menos 8 caracteres' })
  newPassword: string;
}
