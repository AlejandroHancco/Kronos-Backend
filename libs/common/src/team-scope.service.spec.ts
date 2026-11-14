import { TeamScopeService } from './team-scope.service';

describe('TeamScopeService.teamIdsForProject', () => {
  const prisma = { userProjectRole: { findMany: jest.fn() } };
  const service = new TeamScopeService(prisma as any);

  beforeEach(() => jest.clearAllMocks());

  it('devuelve los teamIds (APPROVED) de los miembros con rol en el proyecto', async () => {
    prisma.userProjectRole.findMany.mockResolvedValue([
      { user: { teamMembers: [{ teamId: 'team-a' }] } },
      { user: { teamMembers: [{ teamId: 'team-b' }] } },
    ]);

    const result = await service.teamIdsForProject('project-1');

    expect(result).toEqual(['team-a', 'team-b']);
    expect(prisma.userProjectRole.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: 'project-1' } }),
    );
  });

  it('deduplica teamIds cuando varios miembros del mismo equipo tienen rol en el proyecto', async () => {
    prisma.userProjectRole.findMany.mockResolvedValue([
      { user: { teamMembers: [{ teamId: 'team-a' }] } },
      { user: { teamMembers: [{ teamId: 'team-a' }] } },
    ]);

    const result = await service.teamIdsForProject('project-1');

    expect(result).toEqual(['team-a']);
  });

  it('devuelve lista vacía si el proyecto no tiene miembros con equipo aprobado', async () => {
    prisma.userProjectRole.findMany.mockResolvedValue([
      { user: { teamMembers: [] } },
    ]);

    const result = await service.teamIdsForProject('project-1');

    expect(result).toEqual([]);
  });
});
