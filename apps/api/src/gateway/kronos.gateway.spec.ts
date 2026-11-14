import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { KronosGateway } from './kronos.gateway';
import { WS_AUTH_ERROR } from '../auth/ws-socket';

describe('KronosGateway.onModuleDestroy', () => {
  it('libera el listener de sessionEvents registrado en afterInit', () => {
    const wsAuth = {} as any;
    const teamScope = {} as any;
    const unsubscribe = jest.fn();
    const sessionEvents = { onUserSessionsRevoked: jest.fn().mockReturnValue(unsubscribe) };

    const gateway = new KronosGateway(wsAuth, teamScope, sessionEvents as any);
    (gateway as any).server = { to: jest.fn().mockReturnValue({ emit: jest.fn() }), in: jest.fn().mockReturnValue({ disconnectSockets: jest.fn() }) };

    gateway.afterInit({ use: jest.fn() } as any);
    expect(sessionEvents.onUserSessionsRevoked).toHaveBeenCalledTimes(1);
    expect(unsubscribe).not.toHaveBeenCalled();

    gateway.onModuleDestroy();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

function fakeSocket(user: { id: string } | null, token?: string) {
  return {
    id: 'sock-1',
    handshake: { auth: token === undefined ? {} : { token } },
    data: user ? { user } : {},
    join: jest.fn(),
    leave: jest.fn(),
    emit: jest.fn(),
    disconnect: jest.fn(),
  };
}

describe('KronosGateway auth middleware (afterInit)', () => {
  const sessionEvents = { onUserSessionsRevoked: jest.fn().mockReturnValue(jest.fn()) };

  async function runMiddleware(wsAuth: any, socket: any) {
    const gateway = new KronosGateway(wsAuth, {} as any, sessionEvents as any);
    const use = jest.fn();
    gateway.afterInit({ use } as any);
    expect(use).toHaveBeenCalledTimes(1);
    const next = jest.fn();
    await use.mock.calls[0][0](socket, next);
    return next;
  }

  it('rechaza el handshake sin token con un error (connect_error), sin conectar', async () => {
    const wsAuth = { authenticate: jest.fn().mockRejectedValue(new UnauthorizedException('No token provided')) };
    const socket = fakeSocket(null);
    const next = await runMiddleware(wsAuth, socket);

    expect(wsAuth.authenticate).toHaveBeenCalledWith(undefined);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('No token provided');
    expect(err.data).toEqual({ message: 'No token provided' });
    expect(socket.data.user).toBeUndefined();
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it('errores no-Unauthorized se reportan con un mensaje genérico', async () => {
    const wsAuth = { authenticate: jest.fn().mockRejectedValue(new Error('db down')) };
    const next = await runMiddleware(wsAuth, fakeSocket(null, 'tok'));
    expect(next.mock.calls[0][0].message).toBe('Invalid or missing token');
  });

  it('acepta un token válido y deja el usuario en socket.data.user', async () => {
    const wsAuth = { authenticate: jest.fn().mockResolvedValue({ id: 'u1' }) };
    const socket = fakeSocket(null, 'good');
    const next = await runMiddleware(wsAuth, socket);
    expect(wsAuth.authenticate).toHaveBeenCalledWith('good');
    expect(next).toHaveBeenCalledWith();
    expect(socket.data.user).toEqual({ id: 'u1' });
  });
});

describe('KronosGateway rooms', () => {
  const sessionEvents = { onUserSessionsRevoked: jest.fn().mockReturnValue(jest.fn()) };
  let teamScope: { getTeamId: jest.Mock; assertTaskInTeam: jest.Mock };
  let gateway: KronosGateway;

  beforeEach(() => {
    teamScope = { getTeamId: jest.fn(), assertTaskInTeam: jest.fn() };
    gateway = new KronosGateway({} as any, teamScope as any, sessionEvents as any);
  });

  it('handleConnection une a user:{id} y team:{teamId}', async () => {
    teamScope.getTeamId.mockResolvedValue('t1');
    const socket = fakeSocket({ id: 'u1' });
    await gateway.handleConnection(socket as any);
    expect(socket.join).toHaveBeenCalledWith('user:u1');
    expect(socket.join).toHaveBeenCalledWith('team:t1');
  });

  it('handleConnection: sin equipo (Forbidden) no bloquea ni loguea error', async () => {
    teamScope.getTeamId.mockRejectedValue(new ForbiddenException('No perteneces a ningún equipo'));
    const errorSpy = jest.spyOn((gateway as any).logger, 'error').mockImplementation(() => {});
    jest.spyOn((gateway as any).logger, 'log').mockImplementation(() => {});
    const socket = fakeSocket({ id: 'u1' });
    await gateway.handleConnection(socket as any);
    expect(socket.join).toHaveBeenCalledWith('user:u1');
    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('handleConnection: otros errores al resolver el equipo se loguean', async () => {
    teamScope.getTeamId.mockRejectedValue(new Error('db down'));
    const errorSpy = jest.spyOn((gateway as any).logger, 'error').mockImplementation(() => {});
    jest.spyOn((gateway as any).logger, 'log').mockImplementation(() => {});
    const socket = fakeSocket({ id: 'u1' });
    await gateway.handleConnection(socket as any);
    expect(socket.join).toHaveBeenCalledWith('user:u1');
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('join ignora el id del cuerpo y solo une a la sala propia', async () => {
    const socket = fakeSocket({ id: 'u1' });
    await (gateway.handleJoin as any)(socket, 'someone-else');
    expect(socket.join).toHaveBeenCalledTimes(1);
    expect(socket.join).toHaveBeenCalledWith('user:u1');
  });

  it('join-task rechaza una tarea fuera del equipo con auth:error y sin unirse', async () => {
    teamScope.assertTaskInTeam.mockRejectedValue(new ForbiddenException('fuera del equipo'));
    const socket = fakeSocket({ id: 'u1' });
    await gateway.handleJoinTask(socket as any, 42);
    expect(teamScope.assertTaskInTeam).toHaveBeenCalledWith('u1', 42);
    expect(socket.join).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith(WS_AUTH_ERROR, { message: 'No tienes acceso a esta tarea' });
  });

  it('join-task une a task:{id} cuando la tarea es del equipo', async () => {
    teamScope.assertTaskInTeam.mockResolvedValue(undefined);
    jest.spyOn((gateway as any).logger, 'log').mockImplementation(() => {});
    const socket = fakeSocket({ id: 'u1' });
    await gateway.handleJoinTask(socket as any, '7');
    expect(socket.join).toHaveBeenCalledWith('task:7');
  });
});
