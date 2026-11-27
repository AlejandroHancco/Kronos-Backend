import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '@app/database';

/**
 * Solo deja pasar al superadministrador. Lee `users.isPlatformAdmin` de la BD en cada
 * petición (no del JWT), así que retirar la marca surte efecto de inmediato.
 * Además exige una sesión de nuestro propio JWT (cuenta con contraseña): una sesión de
 * Supabase nunca habilita el panel de plataforma, aunque el email coincida.
 * Debe ir después de CombinedAuthGuard (usa req.user.id = users.uuid y req.user.provider).
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const reqUser: { id?: string; provider?: string } | undefined = context
      .switchToHttp()
      .getRequest().user;
    if (!reqUser?.id || reqUser.provider !== 'jwt') {
      throw new ForbiddenException('Solo el superadministrador');
    }
    const user = await this.prisma.user.findUnique({
      where: { uuid: reqUser.id },
      select: { isPlatformAdmin: true },
    });
    if (!user?.isPlatformAdmin) throw new ForbiddenException('Solo el superadministrador');
    return true;
  }
}
