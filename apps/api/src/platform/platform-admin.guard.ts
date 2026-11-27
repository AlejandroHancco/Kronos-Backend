import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '@app/database';

/**
 * Solo deja pasar al superadministrador. Lee `users.isPlatformAdmin` de la BD en cada
 * petición (no del JWT), así que retirar la marca surte efecto de inmediato.
 * Debe ir después de CombinedAuthGuard (usa req.user.id = users.uuid).
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const userId: string | undefined = context.switchToHttp().getRequest().user?.id;
    const user = userId
      ? await this.prisma.user.findUnique({ where: { uuid: userId }, select: { isPlatformAdmin: true } })
      : null;
    if (!user?.isPlatformAdmin) throw new ForbiddenException('Solo el superadministrador');
    return true;
  }
}
