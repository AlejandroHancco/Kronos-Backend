import { KronosGateway } from './kronos.gateway';

describe('KronosGateway.emitDeviceStatusChanged', () => {
  const wsAuth = {} as any;
  const teamScope = { teamIdsForProject: jest.fn() };
  const sessionEvents = { onUserSessionsRevoked: jest.fn().mockReturnValue(jest.fn()) };

  let gateway: KronosGateway;
  let toMock: jest.Mock;
  let emitMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    gateway = new KronosGateway(wsAuth, teamScope as any, sessionEvents as any);
    emitMock = jest.fn();
    toMock = jest.fn().mockReturnValue({ emit: emitMock });
    (gateway as any).server = { to: toMock, emit: jest.fn() };
  });

  it('emite device:status solo a las salas de los equipos del proyecto, no a todos', async () => {
    teamScope.teamIdsForProject.mockResolvedValue(['team-a', 'team-b']);

    await gateway.emitDeviceStatusChanged('device-1', 'project-1', 'online');

    expect(teamScope.teamIdsForProject).toHaveBeenCalledWith('project-1');
    expect(toMock).toHaveBeenCalledWith('team:team-a');
    expect(toMock).toHaveBeenCalledWith('team:team-b');
    expect(emitMock).toHaveBeenCalledWith('device:status', {
      deviceId: 'device-1',
      projectId: 'project-1',
      status: 'online',
    });
    expect((gateway as any).server.emit).not.toHaveBeenCalled();
  });

  it('no emite nada si el proyecto no pertenece a ningún equipo', async () => {
    teamScope.teamIdsForProject.mockResolvedValue([]);

    await gateway.emitDeviceStatusChanged('device-1', 'project-1', 'offline');

    expect(toMock).not.toHaveBeenCalled();
  });
});

describe('KronosGateway.onModuleDestroy', () => {
  it('libera el listener de sessionEvents registrado en afterInit', () => {
    const wsAuth = {} as any;
    const teamScope = {} as any;
    const unsubscribe = jest.fn();
    const sessionEvents = { onUserSessionsRevoked: jest.fn().mockReturnValue(unsubscribe) };

    const gateway = new KronosGateway(wsAuth, teamScope, sessionEvents as any);
    (gateway as any).server = { to: jest.fn().mockReturnValue({ emit: jest.fn() }), in: jest.fn().mockReturnValue({ disconnectSockets: jest.fn() }) };

    gateway.afterInit();
    expect(sessionEvents.onUserSessionsRevoked).toHaveBeenCalledTimes(1);
    expect(unsubscribe).not.toHaveBeenCalled();

    gateway.onModuleDestroy();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
