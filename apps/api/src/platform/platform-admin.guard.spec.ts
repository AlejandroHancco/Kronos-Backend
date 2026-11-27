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
    const err = await guard.canActivate(ctx({ id: 'u1', teamRole: 'ADMIN', isPlatformAdmin: true })).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.message).toBe('Solo el superadministrador');
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { uuid: 'u1' }, select: { isPlatformAdmin: true } });
  });

  it('rejects an unknown or missing user (403)', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(guard.canActivate(ctx({ id: 'u9' }))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guard.canActivate(ctx(undefined))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows isPlatformAdmin', async () => {
    prisma.user.findUnique.mockResolvedValue({ isPlatformAdmin: true });
    await expect(guard.canActivate(ctx({ id: 'sa' }))).resolves.toBe(true);
  });
});
