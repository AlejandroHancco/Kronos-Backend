import { BadRequestException } from '@nestjs/common';
import { TeamsService } from './teams.service';

describe('TeamsService.updateMemberRole', () => {
  const prisma: any = { teamMember: { findFirst: jest.fn() } };
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
});

describe('TeamsService.joinTeam', () => {
  const prisma: any = { user: { findUnique: jest.fn() }, team: { findUnique: jest.fn() } };
  let svc: TeamsService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.user.findUnique.mockResolvedValue({ uuid: 'u1', banned: false });
    prisma.team.findUnique.mockResolvedValue(null);
    svc = new TeamsService(prisma, {} as any, {} as any, {} as any, {} as any);
  });

  it('looks the code up trimmed and upper-cased', async () => {
    await expect(svc.joinTeam('  giot2026 ', { id: 'u1' } as any)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.team.findUnique).toHaveBeenCalledWith({ where: { code: 'GIOT2026' } });
  });
});
