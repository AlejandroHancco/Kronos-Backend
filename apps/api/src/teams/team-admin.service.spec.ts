import { NotFoundException } from '@nestjs/common';
import { TeamAdminService, projectRoleIdFor } from './team-admin.service';

describe('TeamAdminService', () => {
  const prisma: any = {
    user: { findUnique: jest.fn() },
    teamAdminGrant: { findMany: jest.fn(), updateMany: jest.fn() },
    teamMember: {
      upsert: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      deleteMany: jest.fn(),
      updateMany: jest.fn(),
    },
    project: { findMany: jest.fn() },
    userProjectRole: { upsert: jest.fn() },
    $transaction: jest.fn(async (fn: (tx: any) => any) => fn(prisma)),
  };
  const permissions = { invalidateUserCache: jest.fn() };
  let svc: TeamAdminService;

  const verifiedUser = {
    uuid: 'u1',
    email: 'Maria@PUCP.edu.pe',
    emailVerified: true,
    banned: false,
    isPlatformAdmin: false,
  };
  const openGrant = {
    id: 'g1',
    email: 'maria@pucp.edu.pe',
    teamId: 't1',
    claimedAt: null,
    revokedAt: null,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.teamMember.upsert.mockResolvedValue({});
    prisma.teamMember.deleteMany.mockResolvedValue({ count: 0 });
    prisma.teamMember.findFirst.mockResolvedValue(null);
    prisma.teamMember.findMany.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]);
    prisma.project.findMany.mockResolvedValue([{ uuid: 'p1' }, { uuid: 'p2' }]);
    prisma.userProjectRole.upsert.mockResolvedValue({});
    prisma.teamAdminGrant.updateMany.mockResolvedValue({ count: 1 });
    prisma.teamMember.updateMany.mockResolvedValue({ count: 1 });
    permissions.invalidateUserCache.mockResolvedValue(undefined);
    svc = new TeamAdminService(prisma, permissions as any);
  });

  describe('claimPendingGrants', () => {
    it('claims an open grant for a verified user, case-insensitively', async () => {
      prisma.user.findUnique.mockResolvedValue(verifiedUser);
      prisma.teamAdminGrant.findMany.mockResolvedValue([openGrant]);

      await expect(svc.claimPendingGrants('u1')).resolves.toBe(1);

      const where = prisma.teamAdminGrant.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ email: 'maria@pucp.edu.pe', claimedAt: null, revokedAt: null });
      expect(prisma.teamMember.upsert).toHaveBeenCalledWith({
        where: { userId_teamId: { userId: 'u1', teamId: 't1' } },
        update: { role: 'ADMIN', status: 'APPROVED' },
        create: { userId: 'u1', teamId: 't1', role: 'ADMIN', status: 'APPROVED' },
      });
      const grantUpdate = prisma.teamAdminGrant.updateMany.mock.calls[0][0];
      expect(grantUpdate.where).toEqual({ id: 'g1', claimedAt: null, revokedAt: null });
      expect(grantUpdate.data.claimedAt).toBeInstanceOf(Date);
      expect(grantUpdate.data.claimedById).toBe('u1');
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.userProjectRole.upsert).toHaveBeenCalledWith({
        where: { userId_projectId: { userId: 'u1', projectId: 'p1' } },
        update: { roleId: 2 },
        create: { userId: 'u1', projectId: 'p1', roleId: 2 },
      });
      expect(permissions.invalidateUserCache).toHaveBeenCalledWith('u1');
    });

    it('does nothing for an unverified user', async () => {
      prisma.user.findUnique.mockResolvedValue({ ...verifiedUser, emailVerified: false });
      prisma.teamAdminGrant.findMany.mockResolvedValue([openGrant]);

      await expect(svc.claimPendingGrants('u1')).resolves.toBe(0);
      expect(prisma.teamMember.upsert).not.toHaveBeenCalled();
      expect(prisma.teamAdminGrant.updateMany).not.toHaveBeenCalled();
    });

    it('returns 0 for an unknown user', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(svc.claimPendingGrants('nope')).resolves.toBe(0);
      expect(prisma.teamMember.upsert).not.toHaveBeenCalled();
    });

    it('is idempotent', async () => {
      prisma.user.findUnique.mockResolvedValue(verifiedUser);
      prisma.teamAdminGrant.findMany
        .mockResolvedValueOnce([openGrant])
        .mockResolvedValueOnce([]);

      await expect(svc.claimPendingGrants('u1')).resolves.toBe(1);
      await expect(svc.claimPendingGrants('u1')).resolves.toBe(0);

      for (const call of prisma.teamAdminGrant.findMany.mock.calls) {
        expect(call[0].where).toMatchObject({ claimedAt: null, revokedAt: null });
      }
      expect(prisma.teamMember.upsert).toHaveBeenCalledTimes(1);
      expect(prisma.teamAdminGrant.updateMany).toHaveBeenCalledTimes(1);
    });

    it('leaves the grant open when the user is APPROVED in another team', async () => {
      prisma.user.findUnique.mockResolvedValue(verifiedUser);
      prisma.teamAdminGrant.findMany.mockResolvedValue([openGrant]);
      prisma.teamMember.findFirst.mockResolvedValue({
        teamId: 't2',
        status: 'APPROVED',
        team: { name: 'Otro grupo' },
      });

      await expect(svc.claimPendingGrants('u1')).resolves.toBe(0);
      expect(prisma.teamMember.upsert).not.toHaveBeenCalled();
      expect(prisma.teamAdminGrant.updateMany).not.toHaveBeenCalled();
    });

    it('leaves the grant open when the user is banned', async () => {
      prisma.user.findUnique.mockResolvedValue({ ...verifiedUser, banned: true });
      prisma.teamAdminGrant.findMany.mockResolvedValue([openGrant]);

      await expect(svc.claimPendingGrants('u1')).resolves.toBe(0);
      expect(prisma.teamMember.upsert).not.toHaveBeenCalled();
      expect(prisma.teamAdminGrant.updateMany).not.toHaveBeenCalled();
    });

    it('deletes PENDING/REJECTED memberships in other teams when claiming', async () => {
      prisma.user.findUnique.mockResolvedValue(verifiedUser);
      prisma.teamAdminGrant.findMany.mockResolvedValue([openGrant]);

      await svc.claimPendingGrants('u1');

      expect(prisma.teamMember.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'u1', teamId: { not: 't1' }, status: { in: ['PENDING', 'REJECTED'] } },
      });
    });

    it('applies only the first joinable grant when several are open', async () => {
      prisma.user.findUnique.mockResolvedValue(verifiedUser);
      prisma.teamAdminGrant.findMany.mockResolvedValue([
        openGrant,
        { ...openGrant, id: 'g2', teamId: 't2' },
      ]);

      await expect(svc.claimPendingGrants('u1')).resolves.toBe(1);
      expect(prisma.teamAdminGrant.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.teamAdminGrant.updateMany.mock.calls[0][0].where).toMatchObject({ id: 'g1' });
    });
    it('aborts without member changes when the grant was claimed concurrently', async () => {
      prisma.user.findUnique.mockResolvedValue(verifiedUser);
      prisma.teamAdminGrant.findMany.mockResolvedValue([openGrant]);
      prisma.teamAdminGrant.updateMany.mockResolvedValue({ count: 0 });

      await expect(svc.claimPendingGrants('u1')).resolves.toBe(0);
      expect(prisma.teamMember.deleteMany).not.toHaveBeenCalled();
      expect(prisma.teamMember.upsert).not.toHaveBeenCalled();
      expect(prisma.userProjectRole.upsert).not.toHaveBeenCalled();
      expect(permissions.invalidateUserCache).not.toHaveBeenCalled();
    });

    it('marks the grant before touching memberships', async () => {
      prisma.user.findUnique.mockResolvedValue(verifiedUser);
      prisma.teamAdminGrant.findMany.mockResolvedValue([openGrant]);

      await svc.claimPendingGrants('u1');
      const grantOrder = prisma.teamAdminGrant.updateMany.mock.invocationCallOrder[0];
      expect(grantOrder).toBeLessThan(prisma.teamMember.deleteMany.mock.invocationCallOrder[0]);
      expect(grantOrder).toBeLessThan(prisma.teamMember.upsert.mock.invocationCallOrder[0]);
    });

    it('does not throw when propagation or cache invalidation fails after claiming', async () => {
      prisma.user.findUnique.mockResolvedValue(verifiedUser);
      prisma.teamAdminGrant.findMany.mockResolvedValue([openGrant]);
      permissions.invalidateUserCache.mockRejectedValue(new Error('redis down'));
      const logSpy = jest.spyOn((svc as any).logger, 'error').mockImplementation(() => undefined);

      await expect(svc.claimPendingGrants('u1')).resolves.toBe(1);
      expect(logSpy).toHaveBeenCalled();
    });
  });

  describe('makeAdminInTx / applyRoleSideEffects', () => {
    it('makeAdminInTx clears other PENDING/REJECTED rows and upserts ADMIN on the given client only', async () => {
      const tx: any = { teamMember: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }), upsert: jest.fn() } };
      await svc.makeAdminInTx(tx, 't1', 'u1');
      expect(tx.teamMember.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'u1', teamId: { not: 't1' }, status: { in: ['PENDING', 'REJECTED'] } },
      });
      expect(tx.teamMember.upsert).toHaveBeenCalledWith({
        where: { userId_teamId: { userId: 'u1', teamId: 't1' } },
        update: { role: 'ADMIN', status: 'APPROVED' },
        create: { userId: 'u1', teamId: 't1', role: 'ADMIN', status: 'APPROVED' },
      });
      expect(prisma.teamMember.upsert).not.toHaveBeenCalled();
      expect(permissions.invalidateUserCache).not.toHaveBeenCalled();
    });

    it('applyRoleSideEffects propagates the project role and invalidates the cache', async () => {
      await svc.applyRoleSideEffects('t1', 'u1', 'ADMIN');
      expect(prisma.userProjectRole.upsert).toHaveBeenCalledTimes(2);
      expect(prisma.userProjectRole.upsert.mock.calls[0][0].update).toEqual({ roleId: 2 });
      expect(permissions.invalidateUserCache).toHaveBeenCalledWith('u1');
    });
  });

  describe('adminBlockReason', () => {
    const base = { uuid: 'u1', banned: false, isPlatformAdmin: false };

    it('reports a banned account', async () => {
      await expect(svc.adminBlockReason({ ...base, banned: true }, 't1')).resolves.toBe('cuenta suspendida');
    });

    it('reports a platform admin', async () => {
      await expect(svc.adminBlockReason({ ...base, isPlatformAdmin: true }, 't1')).resolves.toBe(
        'es superadministrador',
      );
    });

    it('reports membership in another team', async () => {
      prisma.teamMember.findFirst.mockResolvedValue({ team: { name: 'Grupo Norte' } });
      await expect(svc.adminBlockReason(base, 't1')).resolves.toBe('ya pertenece a Grupo Norte');
      expect(prisma.teamMember.findFirst.mock.calls[0][0].where).toEqual({
        userId: 'u1',
        status: 'APPROVED',
        teamId: { not: 't1' },
      });
    });

    it('returns null when nothing blocks', async () => {
      await expect(svc.adminBlockReason(base, 't1')).resolves.toBeNull();
    });
  });

  describe('setTeamRole', () => {
    it("setTeamRole('t1','u1','MEMBER') upserts role 4 on the team projects and invalidates cache", async () => {
      await svc.setTeamRole('t1', 'u1', 'MEMBER');

      expect(prisma.teamMember.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u1', teamId: 't1' },
        data: { role: 'MEMBER' },
      });
      expect(prisma.teamMember.upsert).not.toHaveBeenCalled();
      expect(prisma.teamMember.findMany).toHaveBeenCalledWith({
        where: { teamId: 't1', status: 'APPROVED' },
        select: { userId: true },
      });
      expect(prisma.project.findMany).toHaveBeenCalledWith({
        where: { userProjectRoles: { some: { userId: { in: ['u1', 'u2'] } } } },
        select: { uuid: true },
      });
      expect(prisma.userProjectRole.upsert).toHaveBeenCalledTimes(2);
      expect(prisma.userProjectRole.upsert).toHaveBeenCalledWith({
        where: { userId_projectId: { userId: 'u1', projectId: 'p2' } },
        update: { roleId: 4 },
        create: { userId: 'u1', projectId: 'p2', roleId: 4 },
      });
      expect(permissions.invalidateUserCache).toHaveBeenCalledWith('u1');
    });

    it('MEMBER on a missing membership throws NotFoundException and creates nothing', async () => {
      prisma.teamMember.updateMany.mockResolvedValue({ count: 0 });

      await expect(svc.setTeamRole('t1', 'u9', 'MEMBER')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.teamMember.upsert).not.toHaveBeenCalled();
      expect(prisma.userProjectRole.upsert).not.toHaveBeenCalled();
      expect(permissions.invalidateUserCache).not.toHaveBeenCalled();
    });

    it('projectRoleIdFor maps ADMIN to 2 and MEMBER to 4', () => {
      expect(projectRoleIdFor('ADMIN')).toBe(2);
      expect(projectRoleIdFor('MEMBER')).toBe(4);
    });

    it('ADMIN sets status APPROVED and role id 2', async () => {
      await svc.setTeamRole('t1', 'u1', 'ADMIN');

      expect(prisma.teamMember.upsert).toHaveBeenCalledWith({
        where: { userId_teamId: { userId: 'u1', teamId: 't1' } },
        update: { role: 'ADMIN', status: 'APPROVED' },
        create: { userId: 'u1', teamId: 't1', role: 'ADMIN', status: 'APPROVED' },
      });
      expect(prisma.userProjectRole.upsert.mock.calls[0][0].update).toEqual({ roleId: 2 });
    });
  });
});
