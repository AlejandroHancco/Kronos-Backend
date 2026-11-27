import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { PlatformAdminGuard } from './platform-admin.guard';

describe('PlatformAdminGuard', () => {
  const prisma: any = { user: { findUnique: jest.fn() } };
  const guard = new PlatformAdminGuard(prisma);
  const ctx = (user: any) =>
    ({ switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as unknown as ExecutionContext;

  beforeEach(() => jest.clearAllMocks());

  it('rejects a team ADMIN without isPlatformAdmin (403)', async () => {
    prisma.user.findUnique.mockResolvedValue({ isPlatformAdmin: false });
    const err = await guard.canActivate(ctx({ id: 'u1', provider: 'jwt', teamRole: 'ADMIN', isPlatformAdmin: true })).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.message).toBe('Solo el superadministrador');
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { uuid: 'u1' }, select: { isPlatformAdmin: true } });
  });

  it('rejects an unknown or missing user (403)', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(guard.canActivate(ctx({ id: 'u9', provider: 'jwt' }))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guard.canActivate(ctx(undefined))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows isPlatformAdmin with a password (own JWT) session', async () => {
    prisma.user.findUnique.mockResolvedValue({ isPlatformAdmin: true });
    await expect(guard.canActivate(ctx({ id: 'sa', provider: 'jwt' }))).resolves.toBe(true);
  });

  it('rejects isPlatformAdmin when the session comes from Supabase (403)', async () => {
    prisma.user.findUnique.mockResolvedValue({ isPlatformAdmin: true });
    const err = await guard.canActivate(ctx({ id: 'sa', provider: 'supabase' })).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a session without provider (403)', async () => {
    prisma.user.findUnique.mockResolvedValue({ isPlatformAdmin: true });
    await expect(guard.canActivate(ctx({ id: 'sa' }))).rejects.toBeInstanceOf(ForbiddenException);
  });
});
