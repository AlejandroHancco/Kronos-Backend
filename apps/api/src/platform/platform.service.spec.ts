import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PlatformService } from './platform.service';

describe('PlatformService', () => {
  const prisma: any = {
    team: { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn() },
    user: { findFirst: jest.fn(), findMany: jest.fn() },
    teamMember: { findFirst: jest.fn(), count: jest.fn(), create: jest.fn(), deleteMany: jest.fn() },
    teamAdminGrant: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      count: jest.fn(),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn(async (fn: (tx: any) => any) => fn(prisma)),
  };
  const mail = { send: jest.fn() };
  const teamAdmin = {
    setTeamRole: jest.fn(),
    adminBlockReason: jest.fn(),
    makeAdminInTx: jest.fn(),
    applyRoleSideEffects: jest.fn(),
  };
  const config = { get: jest.fn((k: string) => (k === 'FRONTEND_URL' ? 'https://app.test/' : undefined)) };
  let svc: PlatformService;

  const team = { id: 't1', name: 'GIOT', code: 'ABCD1234', createdAt: new Date('2026-01-01') };
  const verifiedUser = { uuid: 'u1', name: 'María', email: 'Maria@PUCP.edu.pe', emailVerified: true, banned: false, isPlatformAdmin: false };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.team.findUnique.mockResolvedValue(team);
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.teamAdminGrant.findFirst.mockResolvedValue(null);
    prisma.teamAdminGrant.create.mockImplementation(async ({ data }: any) => ({ id: 'g1', createdAt: new Date(), ...data }));
    prisma.teamAdminGrant.updateMany.mockResolvedValue({ count: 1 });
    prisma.teamMember.deleteMany.mockResolvedValue({ count: 0 });
    teamAdmin.adminBlockReason.mockResolvedValue(null);
    teamAdmin.setTeamRole.mockResolvedValue(undefined);
    teamAdmin.makeAdminInTx.mockResolvedValue(undefined);
    teamAdmin.applyRoleSideEffects.mockResolvedValue(undefined);
    mail.send.mockResolvedValue(undefined);
    svc = new PlatformService(prisma, teamAdmin as any, mail as any, config as any);
  });

  describe('addAdmin', () => {
    it('promotes a verified existing user immediately and sends the notice', async () => {
      prisma.user.findFirst.mockResolvedValue(verifiedUser);

      await expect(svc.addAdmin('t1', '  maria@pucp.edu.pe ', 'sa')).resolves.toEqual({ status: 'admin' });

      expect(prisma.user.findFirst.mock.calls[0][0].where).toEqual({
        email: { equals: 'maria@pucp.edu.pe', mode: 'insensitive' },
      });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(teamAdmin.makeAdminInTx).toHaveBeenCalledWith(prisma, 't1', 'u1');
      // Una invitación abierta previa para ese correo y grupo queda marcada como reclamada.
      const mark = prisma.teamAdminGrant.updateMany.mock.calls[0][0];
      expect(mark.where).toEqual({ email: 'maria@pucp.edu.pe', teamId: 't1', claimedAt: null, revokedAt: null });
      expect(mark.data.claimedAt).toBeInstanceOf(Date);
      expect(mark.data.claimedById).toBe('u1');
      expect(teamAdmin.applyRoleSideEffects).toHaveBeenCalledWith('t1', 'u1', 'ADMIN');
      expect(teamAdmin.setTeamRole).not.toHaveBeenCalled();
      expect(prisma.teamAdminGrant.create).not.toHaveBeenCalled();
      expect(mail.send).toHaveBeenCalledTimes(1);
      const msg = mail.send.mock.calls[0][0];
      expect(msg.to).toBe('Maria@PUCP.edu.pe');
      expect(msg.text).toContain('GIOT');
      expect(msg.text).toContain('https://app.test');
      expect(msg.text).not.toMatch(/token/i);
      expect(msg.html).not.toMatch(/token/i);
    });

    it('creates an open grant for an unknown email (lower-cased)', async () => {
      await expect(svc.addAdmin('t1', 'New@Lab.PE', 'sa')).resolves.toEqual({ status: 'pending' });
      expect(prisma.teamAdminGrant.create).toHaveBeenCalledWith({
        data: { email: 'new@lab.pe', teamId: 't1', invitedById: 'sa' },
      });
      expect(mail.send.mock.calls[0][0].to).toBe('new@lab.pe');

      // Segunda vez: ya existe una invitación abierta, no se crea otra.
      prisma.teamAdminGrant.findFirst.mockResolvedValue({ id: 'g1', email: 'new@lab.pe', teamId: 't1' });
      await expect(svc.addAdmin('t1', 'new@lab.pe', 'sa')).resolves.toEqual({ status: 'pending' });
      expect(prisma.teamAdminGrant.create).toHaveBeenCalledTimes(1);
      expect(prisma.teamAdminGrant.findFirst.mock.calls[1][0].where).toEqual({
        email: 'new@lab.pe',
        teamId: 't1',
        claimedAt: null,
        revokedAt: null,
      });
    });

    it('returns pending_verification for an unverified account', async () => {
      prisma.user.findFirst.mockResolvedValue({ ...verifiedUser, emailVerified: false });
      await expect(svc.addAdmin('t1', 'maria@pucp.edu.pe', 'sa')).resolves.toEqual({
        status: 'pending_verification',
      });
      expect(teamAdmin.makeAdminInTx).not.toHaveBeenCalled();
      expect(prisma.teamAdminGrant.create).toHaveBeenCalledTimes(1);
      expect(mail.send).toHaveBeenCalledTimes(1);
    });

    it.each(['ya pertenece a OTRO', 'cuenta suspendida', 'es superadministrador'])(
      'returns 409 when adminBlockReason is "%s"',
      async (reason) => {
        prisma.user.findFirst.mockResolvedValue(verifiedUser);
        teamAdmin.adminBlockReason.mockResolvedValue(reason);
        const err = await svc.addAdmin('t1', 'maria@pucp.edu.pe', 'sa').catch((e) => e);
        expect(err).toBeInstanceOf(ConflictException);
        expect(err.message).toContain(reason);
        expect(teamAdmin.makeAdminInTx).not.toHaveBeenCalled();
        expect(prisma.teamAdminGrant.create).not.toHaveBeenCalled();
        expect(mail.send).not.toHaveBeenCalled();
      },
    );

    it('keeps the assignment when the notice email fails', async () => {
      prisma.user.findFirst.mockResolvedValue(verifiedUser);
      mail.send.mockRejectedValue(new Error('Brevo caído'));
      await expect(svc.addAdmin('t1', 'maria@pucp.edu.pe', 'sa')).resolves.toEqual({ status: 'admin' });
      expect(teamAdmin.makeAdminInTx).toHaveBeenCalled();
    });

    it('keeps the admin when role propagation fails after commit', async () => {
      prisma.user.findFirst.mockResolvedValue(verifiedUser);
      teamAdmin.applyRoleSideEffects.mockRejectedValue(new Error('redis caído'));
      await expect(svc.addAdmin('t1', 'maria@pucp.edu.pe', 'sa')).resolves.toEqual({ status: 'admin' });
      expect(mail.send).toHaveBeenCalledTimes(1);
    });

    it('returns 404 for an unknown team', async () => {
      prisma.team.findUnique.mockResolvedValue(null);
      await expect(svc.addAdmin('tx', 'a@b.pe', 'sa')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('removeAdmin', () => {
    beforeEach(() => {
      prisma.teamMember.findFirst.mockResolvedValue({ userId: 'u1', teamId: 't1', role: 'ADMIN', status: 'APPROVED' });
    });

    it('refuses the last ADMIN (409)', async () => {
      prisma.teamMember.count.mockResolvedValue(1);
      await expect(svc.removeAdmin('t1', 'u1')).rejects.toBeInstanceOf(ConflictException);
      expect(teamAdmin.setTeamRole).not.toHaveBeenCalled();
    });

    it('demotes via setTeamRole(..., MEMBER)', async () => {
      prisma.teamMember.count.mockResolvedValue(2);
      await svc.removeAdmin('t1', 'u1');
      expect(prisma.teamMember.count.mock.calls[0][0].where).toEqual({ teamId: 't1', role: 'ADMIN', status: 'APPROVED' });
      expect(teamAdmin.setTeamRole).toHaveBeenCalledWith('t1', 'u1', 'MEMBER');
    });

    it('returns 404 when the user is not an ADMIN of the team', async () => {
      prisma.teamMember.findFirst.mockResolvedValue(null);
      await expect(svc.removeAdmin('t1', 'u9')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('revokeGrant', () => {
    const grant = { id: 'g1', teamId: 't1', email: 'a@b.pe', claimedAt: null, revokedAt: null };

    it('refuses the last open grant of a team without admins (409)', async () => {
      prisma.teamAdminGrant.findUnique.mockResolvedValue(grant);
      prisma.teamMember.count.mockResolvedValue(0);
      prisma.teamAdminGrant.count.mockResolvedValue(1);
      await expect(svc.revokeGrant('g1')).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.teamAdminGrant.updateMany).not.toHaveBeenCalled();
    });

    it('revokes when the team has an admin', async () => {
      prisma.teamAdminGrant.findUnique.mockResolvedValue(grant);
      prisma.teamMember.count.mockResolvedValue(1);
      prisma.teamAdminGrant.count.mockResolvedValue(1);
      await svc.revokeGrant('g1');
      const call = prisma.teamAdminGrant.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'g1', claimedAt: null, revokedAt: null });
      expect(call.data.revokedAt).toBeInstanceOf(Date);
    });

    it('returns 404 for a grant that is not open', async () => {
      prisma.teamAdminGrant.findUnique.mockResolvedValue({ ...grant, claimedAt: new Date() });
      await expect(svc.revokeGrant('g1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('createTeam', () => {
    beforeEach(() => {
      prisma.team.create.mockImplementation(async ({ data }: any) => ({ id: 't2', createdAt: new Date(), ...data }));
    });

    it('rejects a duplicate code with 409 (P2002)', async () => {
      prisma.team.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'x' }),
      );
      await expect(svc.createTeam({ name: 'Lab', code: 'LAB-1', adminEmail: 'a@b.pe' }, 'sa')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(mail.send).not.toHaveBeenCalled();
    });

    it('creates team and open grant atomically, generating a code', async () => {
      const res = await svc.createTeam({ name: '  Lab  ', adminEmail: 'Boss@Lab.pe' }, 'sa');
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      const data = prisma.team.create.mock.calls[0][0].data;
      expect(data.name).toBe('Lab');
      expect(data.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
      expect(prisma.teamAdminGrant.create).toHaveBeenCalledWith({
        data: { email: 'boss@lab.pe', teamId: 't2', invitedById: 'sa' },
      });
      expect(res).toMatchObject({ id: 't2', name: 'Lab', memberCount: 0, admins: [] });
      expect(res.grants).toEqual([expect.objectContaining({ id: 'g1', email: 'boss@lab.pe', status: 'pending' })]);
      expect(mail.send).toHaveBeenCalledTimes(1);
    });

    it('makes a verified existing user the first admin', async () => {
      prisma.user.findFirst.mockResolvedValue(verifiedUser);
      const res = await svc.createTeam({ name: 'Lab', code: 'LAB-1', adminEmail: 'maria@pucp.edu.pe' }, 'sa');
      expect(teamAdmin.makeAdminInTx).toHaveBeenCalledWith(prisma, 't2', 'u1');
      expect(teamAdmin.applyRoleSideEffects).toHaveBeenCalledWith('t2', 'u1', 'ADMIN');
      expect(res.admins).toEqual([{ userId: 'u1', name: 'María', email: 'Maria@PUCP.edu.pe' }]);
      expect(res.memberCount).toBe(1);
      expect(res.code).toBe('LAB-1');
    });

    it('still returns the created team when role propagation fails after commit', async () => {
      prisma.user.findFirst.mockResolvedValue(verifiedUser);
      teamAdmin.applyRoleSideEffects.mockRejectedValue(new Error('redis caído'));
      const res = await svc.createTeam({ name: 'Lab', code: 'LAB-1', adminEmail: 'maria@pucp.edu.pe' }, 'sa');
      expect(res).toMatchObject({ id: 't2', memberCount: 1 });
      expect(mail.send).toHaveBeenCalledTimes(1);
    });

    it('upper-cases a generated or given code', async () => {
      const res = await svc.createTeam({ name: 'Lab', code: ' lab-1 ', adminEmail: 'a@b.pe' }, 'sa');
      expect(res.code).toBe('LAB-1');
    });

    it('refuses a blocked first admin with 409 and creates no team', async () => {
      prisma.user.findFirst.mockResolvedValue(verifiedUser);
      teamAdmin.adminBlockReason.mockResolvedValue('ya pertenece a GIOT');
      await expect(svc.createTeam({ name: 'Lab', adminEmail: 'maria@pucp.edu.pe' }, 'sa')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.team.create).not.toHaveBeenCalled();
    });
  });

  describe('listTeams', () => {
    it('maps admins, member count and grant statuses', async () => {
      prisma.team.findMany.mockResolvedValue([
        {
          ...team,
          _count: { members: 3 },
          members: [{ user: { uuid: 'u1', name: 'María', email: 'm@x.pe' } }],
          adminGrants: [
            { id: 'g1', email: 'new@x.pe', createdAt: team.createdAt },
            { id: 'g2', email: 'unv@x.pe', createdAt: team.createdAt },
            { id: 'g3', email: 'blk@x.pe', createdAt: team.createdAt },
          ],
        },
      ]);
      prisma.user.findMany.mockResolvedValue([
        { uuid: 'u2', email: 'UNV@x.pe', emailVerified: false, banned: false, isPlatformAdmin: false },
        { uuid: 'u3', email: 'blk@x.pe', emailVerified: true, banned: true, isPlatformAdmin: false },
      ]);
      teamAdmin.adminBlockReason.mockImplementation(async (u: any) => (u.banned ? 'cuenta suspendida' : null));

      const [row] = await svc.listTeams();
      expect(row).toMatchObject({ id: 't1', name: 'GIOT', code: 'ABCD1234', memberCount: 3 });
      expect(row.admins).toEqual([{ userId: 'u1', name: 'María', email: 'm@x.pe' }]);
      expect(row.grants).toEqual([
        { id: 'g1', email: 'new@x.pe', createdAt: team.createdAt, status: 'pending' },
        { id: 'g2', email: 'unv@x.pe', createdAt: team.createdAt, status: 'pending_verification' },
        { id: 'g3', email: 'blk@x.pe', createdAt: team.createdAt, status: 'blocked', reason: 'cuenta suspendida' },
      ]);
    });
  });
});

describe('CreateTeamDto', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { plainToInstance } = require('class-transformer');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { validateSync } = require('class-validator');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { CreateTeamDto } = require('./dto/create-team.dto');
  const errors = (body: object) =>
    validateSync(plainToInstance(CreateTeamDto, body)).map((e: any) => e.property);

  it('trims and accepts valid input; empty code means generated', () => {
    const dto = plainToInstance(CreateTeamDto, { name: '  Lab ', code: ' ', adminEmail: ' a@b.pe ' });
    expect(validateSync(dto)).toEqual([]);
    expect(dto).toMatchObject({ name: 'Lab', code: undefined, adminEmail: 'a@b.pe' });
  });

  it('upper-cases the code', () => {
    const dto = plainToInstance(CreateTeamDto, { name: 'Lab', code: ' giot-26 ', adminEmail: 'a@b.pe' });
    expect(validateSync(dto)).toEqual([]);
    expect(dto.code).toBe('GIOT-26');
  });

  it('rejects bad name, code and email', () => {
    expect(errors({ name: '   ', adminEmail: 'a@b.pe' })).toEqual(['name']);
    expect(errors({ name: 'x'.repeat(101), adminEmail: 'a@b.pe' })).toEqual(['name']);
    expect(errors({ name: 'Lab\nBcc: x', adminEmail: 'a@b.pe' })).toEqual(['name']);
    expect(errors({ name: 'Lab\rX', adminEmail: 'a@b.pe' })).toEqual(['name']);
    expect(errors({ name: 'Lab', code: 'abc', adminEmail: 'a@b.pe' })).toEqual(['code']);
    expect(errors({ name: 'Lab', code: 'LAB_01', adminEmail: 'a@b.pe' })).toEqual(['code']);
    expect(errors({ name: 'Lab', adminEmail: 'nope' })).toEqual(['adminEmail']);
  });
});
