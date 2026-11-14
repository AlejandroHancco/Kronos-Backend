import { RealtimePublisher } from './realtime.publisher';

const calls: { ns: string; room?: string; event: string; payload: unknown }[] = [];

jest.mock('@socket.io/redis-emitter', () => ({
  Emitter: jest.fn().mockImplementation(() => ({
    of: (ns: string) => ({
      to: (room: string) => ({
        emit: (event: string, payload: unknown) => calls.push({ ns, room, event, payload }),
      }),
      emit: (event: string, payload: unknown) => calls.push({ ns, event, payload }),
    }),
  })),
}));

describe('RealtimePublisher', () => {
  let publisher: RealtimePublisher;
  let teamScope: { teamIdsForProject: jest.Mock };

  beforeEach(() => {
    calls.length = 0;
    teamScope = { teamIdsForProject: jest.fn().mockResolvedValue(['t1', 't2']) };
    publisher = new RealtimePublisher({} as any, teamScope as any);
  });

  it('measurementComplete emits to task room with taskId merged', () => {
    publisher.measurementComplete(7, { a: 1 });
    expect(calls).toEqual([
      { ns: '/kronos', room: 'task:7', event: 'measurement:complete', payload: { taskId: 7, a: 1 } },
    ]);
  });

  it('jobStatus emits to user room', () => {
    const status = { jobId: 'j', status: 'queued' as const };
    publisher.jobStatus('u1', status);
    expect(calls).toEqual([{ ns: '/kronos', room: 'user:u1', event: 'job:status', payload: status }]);
  });

  it('notification emits to user room', () => {
    const n = { id: 'n1', title: 't' };
    publisher.notification('u1', n);
    expect(calls).toEqual([{ ns: '/kronos', room: 'user:u1', event: 'notification', payload: n }]);
  });

  it('deviceStatus emits to each team room of the project on /kronos', async () => {
    await publisher.deviceStatus('d1', 'p1', 'online');
    expect(teamScope.teamIdsForProject).toHaveBeenCalledWith('p1');
    const payload = { deviceId: 'd1', projectId: 'p1', status: 'online' };
    expect(calls).toEqual([
      { ns: '/kronos', room: 'team:t1', event: 'device:status', payload },
      { ns: '/kronos', room: 'team:t2', event: 'device:status', payload },
    ]);
  });

  it('deviceStatus emits nothing when the project has no teams', async () => {
    teamScope.teamIdsForProject.mockResolvedValue([]);
    await publisher.deviceStatus('d1', 'p1', 'offline');
    expect(calls).toEqual([]);
  });

  it('measurementProgress keeps the legacy payload', () => {
    publisher.measurementProgress('u1', 'j1', 2, 4, 50, 'msg');
    expect(calls).toContainEqual({
      ns: '/measurements', room: 'u1', event: 'measurement:progress',
      payload: { jobId: 'j1', channel: 2, total: 4, percent: 50, status: 'measuring', message: 'msg' },
    });
  });

  it('measurementCompleted keeps the legacy payload', () => {
    const takenAt = new Date();
    const sensorValues = [{ name: 'z', unit: 'Ω' }];
    const acquisition = { kind: 'single' };
    publisher.measurementCompleted('u1', 'j1', 9, takenAt, 100, { x: 1 }, sensorValues, acquisition, [1, 3]);
    expect(calls).toEqual([
      { ns: '/measurements', room: 'u1', event: 'measurement:completed',
        payload: { jobId: 'j1', measurementId: 9, takenAt, totalPoints: 100, data: { x: 1 }, sensorValues, acquisition, channels: [1, 3] } },
    ]);
  });

  it('measurementError keeps the legacy payload', () => {
    publisher.measurementError('u1', 'j1', 'boom');
    expect(calls).toEqual([
      { ns: '/measurements', room: 'u1', event: 'measurement:error', payload: { jobId: 'j1', message: 'boom' } },
    ]);
  });
});
