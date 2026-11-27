import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { TeamsService } from './teams.service';

describe('TeamsService.updateMemberRole', () => {
  const prisma: any = { teamMember: { findFirst: jest.fn() }, user: { findUnique: jest.fn() } };
  const teamScope = { assertTeamAccess: jest.fn() };
  const permissions = { invalidateUserCache: jest.fn() };
  const notifications = {};
  const teamAdmin = { setTeamRole: jest.fn() };
  const caller: any = { id: 'admin1', email: 'admin@x.com' };
  let svc: TeamsService;

  beforeEach(() => {
    jest.clearAllMocks();
    teamScope.assertTeamAccess.mockResolvedValue(undefined);
    teamAdmin.setTeamRole.mockResolvedValue(undefined);
    prisma.user.findUnique.mockResolvedValue({ isPlatformAdmin: false });
    svc = new TeamsService(prisma, teamScope as any, permissions as any, notifications as any, teamAdmin as any);
  });

  const mockMembers = (targetStatus: string) =>
    prisma.teamMember.findFirst
      .mockResolvedValueOnce({ id: 'm0', userId: 'admin1', role: 'ADMIN', status: 'APPROVED' })
      .mockResolvedValueOnce({ id: 'm1', userId: 'u1', role: 'MEMBER', status: targetStatus });

  it('rejects a PENDING target with 400 and changes nothing', async () => {
    mockMembers('PENDING');
    await expect(svc.updateMemberRole('t1', 'u1', 'ADMIN', caller)).rejects.toThrow(
      new BadRequestException('Primero aprueba la solicitud de este miembro'),
    );
    expect(teamAdmin.setTeamRole).not.toHaveBeenCalled();
  });

  it('delegates to teamAdmin.setTeamRole for an APPROVED target', async () => {
    mockMembers('APPROVED');
    await expect(svc.updateMemberRole('t1', 'u1', 'ADMIN', caller)).resolves.toEqual({
      message: 'Rol actualizado a ADMIN',
      userId: 'u1',
      newTeamRole: 'ADMIN',
      newProjectRoleId: 2,
    });
    expect(teamAdmin.setTeamRole).toHaveBeenCalledWith('t1', 'u1', 'ADMIN');
  });

  it('returns project role 4 when demoting to MEMBER', async () => {
    mockMembers('APPROVED');
    const res = await svc.updateMemberRole('t1', 'u1', 'MEMBER', caller);
    expect(res.newProjectRoleId).toBe(4);
    expect(teamAdmin.setTeamRole).toHaveBeenCalledWith('t1', 'u1', 'MEMBER');
  });

  it('refuses to give a team role to a platform admin (403)', async () => {
    mockMembers('APPROVED');
    prisma.user.findUnique.mockResolvedValue({ isPlatformAdmin: true });
    await expect(svc.updateMemberRole('t1', 'u1', 'ADMIN', caller)).rejects.toBeInstanceOf(ForbiddenException);
    expect(teamAdmin.setTeamRole).not.toHaveBeenCalled();
  });
});

describe('TeamsService.approveMember', () => {
  const prisma: any = {
    teamMember: { findFirst: jest.fn(), update: jest.fn() },
    user: { findUnique: jest.fn() },
  };
  const permissions = { invalidateUserCache: jest.fn() };
  const notifications = { notifyMemberApproved: jest.fn() };
  const admin: any = { id: 'admin1' };
  let svc: TeamsService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.teamMember.findFirst
      .mockResolvedValueOnce({ id: 'm0', userId: 'admin1', teamId: 't1', role: 'ADMIN', status: 'APPROVED' })
      .mockResolvedValueOnce({ id: 'm1', userId: 'u1', teamId: 't1', status: 'PENDING' });
    prisma.teamMember.update.mockResolvedValue({
      status: 'APPROVED',
      user: { uuid: 'u1', name: 'Ana' },
      team: { id: 't1', name: 'GIOT' },
    });
    svc = new TeamsService(prisma, {} as any, permissions as any, notifications as any, {} as any);
  });

  it('refuses to approve a platform admin (403) and changes nothing', async () => {
    prisma.user.findUnique.mockResolvedValue({ isPlatformAdmin: true });
    await expect(svc.approveMember('t1', 'u1', admin)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.teamMember.update).not.toHaveBeenCalled();
  });

  it('approves a normal user', async () => {
    prisma.user.findUnique.mockResolvedValue({ isPlatformAdmin: false });
    await expect(svc.approveMember('t1', 'u1', admin)).resolves.toMatchObject({ message: 'Solicitud aprobada' });
    expect(prisma.teamMember.update).toHaveBeenCalled();
  });
});

describe('TeamsService.joinTeam', () => {
  const prisma: any = {
    user: { findUnique: jest.fn() },
    team: { findUnique: jest.fn() },
    teamMember: { findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), findMany: jest.fn() },
  };
  const notifications = { notifyAdminNewRequest: jest.fn() };
  let svc: TeamsService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.user.findUnique.mockResolvedValue({ uuid: 'u1', banned: false });
    prisma.team.findUnique.mockResolvedValue(null);
    prisma.teamMember.findUnique.mockResolvedValue(null);
    prisma.teamMember.findFirst.mockResolvedValue(null);
    prisma.teamMember.findMany.mockResolvedValue([]);
    svc = new TeamsService(prisma, {} as any, {} as any, notifications as any, {} as any);
  });

  it('refuses a platform admin (403) before looking up the team', async () => {
    prisma.user.findUnique.mockResolvedValue({ uuid: 'sa', banned: false, isPlatformAdmin: true });
    await expect(svc.joinTeam('GIOT2026', { id: 'sa' } as any)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.team.findUnique).not.toHaveBeenCalled();
    expect(prisma.teamMember.create).not.toHaveBeenCalled();
  });

  it('refuses a user already APPROVED in another team (400)', async () => {
    prisma.team.findUnique.mockResolvedValue({ id: 't2', name: 'Otro', code: 'OTRO' });
    prisma.teamMember.findFirst.mockResolvedValue({ id: 'm-other' });
    await expect(svc.joinTeam('OTRO', { id: 'u1' } as any)).rejects.toThrow(
      new BadRequestException('Ya perteneces a un grupo'),
    );
    expect(prisma.teamMember.findFirst).toHaveBeenCalledWith({
      where: { userId: 'u1', status: 'APPROVED', teamId: { not: 't2' } },
      select: { id: true },
    });
    expect(prisma.teamMember.create).not.toHaveBeenCalled();
  });

  it('creates a PENDING request for a user without a team', async () => {
    prisma.team.findUnique.mockResolvedValue({ id: 't2', name: 'Otro', code: 'OTRO' });
    await expect(svc.joinTeam('OTRO', { id: 'u1' } as any)).resolves.toEqual({
      message: 'Solicitud enviada',
      status: 'PENDING',
    });
    expect(prisma.teamMember.create).toHaveBeenCalled();
  });

  it('looks the code up trimmed and upper-cased', async () => {
    await expect(svc.joinTeam('  giot2026 ', { id: 'u1' } as any)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.team.findUnique).toHaveBeenCalledWith({ where: { code: 'GIOT2026' } });
  });
});
