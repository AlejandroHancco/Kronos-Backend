import { UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NormalizedUser } from './interfaces/auth.interface';

export const PASSWORD_CHANGED_MESSAGE = 'La sesión fue cerrada por un cambio de contraseña';

/**
 * Validación compartida (HTTP y WebSocket) de un payload de JWT propio ya verificado:
 * el usuario debe existir y el token no puede ser anterior al último cambio de contraseña.
 */
export async function assertJwtUserActive(
  prisma: Pick<PrismaService, 'user'>,
  payload: { sub?: string; iat?: number },
): Promise<NormalizedUser> {
  const user = await prisma.user.findUnique({
    where: { uuid: payload.sub },
  });

  if (!user) {
    throw new UnauthorizedException('User not found');
  }

  // payload.iat está en segundos; un token emitido en el mismo segundo del
  // cambio de contraseña se acepta (no hay forma de distinguirlo del nuevo token).
  if (
    user.passwordChangedAt &&
    (payload.iat ?? 0) < Math.floor(user.passwordChangedAt.getTime() / 1000)
  ) {
    throw new UnauthorizedException(PASSWORD_CHANGED_MESSAGE);
  }

  return {
    id: user.uuid,
    email: user.email,
    provider: 'jwt',
  } satisfies NormalizedUser;
}
