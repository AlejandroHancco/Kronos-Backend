import { BadRequestException, ConflictException, GatewayTimeoutException, NotFoundException } from '@nestjs/common';
import { HIOKI_IM3570, KRONOS_MUX_16, LaasCatalog, SIM_TEMPERATURE } from '@app/laas-catalog';
import { DeviceOpFailedError, DeviceOpTimeoutError } from '@app/queue';
import { deviceBusyMessage } from '@app/redis';
import { LaasInstancesService } from './laas-instances.service';

const HIOKI = '11111111-1111-4111-8111-111111111111';
const MUX = '22222222-2222-4222-8222-222222222222';
const TEMP = '33333333-3333-4333-8333-333333333333';
const ARCHIVED = '44444444-4444-4444-8444-444444444444';
const OTHER_TEAM = '55555555-5555-4555-8555-555555555555';
const OTHER_HIOKI = '66666666-6666-4666-8666-666666666666';

const dev = (id: string, name: string, type: string, team: string, status = 'online', ip: string | null = '10.0.0.5') =>
  ({ id, name, type, ip, status, team, projectId: `p-${team}`, configuration: null, createdAt: new Date() });

const DEVICES = [
  dev(HIOKI, 'Hioki A', 'hioki-im3570', 't1'),
  dev(MUX, 'MUX A', 'kronos-mux-16', 't1'),
  dev(TEMP, 'Termómetro', 'sim-temperature', 't1', 'offline', null),
  dev(ARCHIVED, 'Viejo', 'hioki-im3570', 't1', 'archived'),
  dev(OTHER_TEAM, 'Hioki B', 'hioki-im3570', 't2'),
  dev(OTHER_HIOKI, 'Hioki A2', 'hioki-im3570', 't1'),
];

const matches = (d: (typeof DEVICES)[number], where: any) =>
  d.team === where.project.team && (where.status?.not === undefined || d.status !== where.status.not) && (where.id === undefined || d.id === where.id);

function setup() {
  const catalog = new LaasCatalog([HIOKI_IM3570, KRONOS_MUX_16, SIM_TEMPERATURE]);
  const prisma = {
    device: {
      findMany: jest.fn(async ({ where }: any) => DEVICES.filter((d) => matches(d, where))),
      findFirst: jest.fn(async ({ where }: any) => DEVICES.find((d) => matches(d, where)) ?? null),
    },
    measurement: {
      groupBy: jest.fn(async (): Promise<any[]> => []),
      findFirst: jest.fn(async (): Promise<any> => null),
    },
  };
  const teamScope = {
    projectWhereForUser: jest.fn(async () => ({ team: 't1' })),
    assertTaskInTeam: jest.fn(async (_u: string, taskId: number) => {
      if (taskId === 999) throw new NotFoundException('Task not found');
    }),
  };
  const experimentConfig = { resolve: jest.fn(async (): Promise<any> => null) };
  const scheduling = { requestMeasurement: jest.fn(async (): Promise<any> => ({ jobId: '42', status: 'queued', estimatedSeconds: 33, estimatedWaitSeconds: 0 })) };
  const deviceOps = { request: jest.fn(async (): Promise<any> => true) };
  const deviceState = { isBusy: jest.fn(async () => false) };
  const service = new LaasInstancesService(
    prisma as any, teamScope as any, catalog, experimentConfig as any, scheduling as any, deviceOps as any, deviceState as any,
  );
  return { service, prisma, teamScope, experimentConfig, scheduling, deviceOps, deviceState };
}

describe('LaasInstancesService: getSensorMetadata / getActuatorMetadata', () => {
  it('solo sensores de equipos no archivados del equipo de trabajo, Tabla 14 con protocol http y x-deviceProtocol', async () => {
    const { service, prisma } = setup();
    prisma.measurement.groupBy.mockResolvedValue([
      { sensorDeviceId: HIOKI, sensorId: 'hioki-im3570-lcr', _max: { takenAt: new Date('2026-11-01T10:00:00Z') } },
    ]);
    const sensors = await service.sensors('u1');
    expect(sensors.map((s) => s.sensorId)).toEqual([`${HIOKI}:hioki-im3570-lcr`, `${TEMP}:sim-temperature-th`, `${OTHER_HIOKI}:hioki-im3570-lcr`]);
    const hioki = sensors[0];
    expect(Object.keys(hioki)).toEqual(expect.arrayContaining(['sensorId', 'fullName', 'description', 'protocol', 'produces', 'sensorValues', 'sensorConfiguration', 'accessMode']));
    expect(hioki).toMatchObject({ protocol: 'http', 'x-deviceProtocol': 'tcp', 'x-device': { id: HIOKI, name: 'Hioki A', deviceType: 'hioki-im3570' } });
    // Tabla 15: lastMeasured (columnas de atribución) y label como extensión x-label
    expect(hioki.sensorValues.every((v) => v.lastMeasured === '2026-11-01T10:00:00.000Z')).toBe(true);
    expect(hioki.sensorValues[0]).not.toHaveProperty('label');
    expect(hioki.sensorValues[0]['x-label']).toEqual(expect.any(String));
    expect(sensors[1].sensorValues[0]).not.toHaveProperty('lastMeasured');
    // Tabla 16: sweep → start/stop (double, unidad de la variable), points (integer), scale (string)
    expect(hioki.sensorConfiguration.map((c) => [c.parameter, c.type])).toEqual([['start', 'double'], ['stop', 'double'], ['points', 'integer'], ['scale', 'string']]);
    expect(hioki.sensorConfiguration[0]['x-unit']).toBe('Hz');
    // single → sin parámetros
    expect(sensors[1].sensorConfiguration).toEqual([]);
    expect(prisma.measurement.groupBy).toHaveBeenCalledWith(expect.objectContaining({ where: { sensorDeviceId: { in: [HIOKI, TEMP, OTHER_HIOKI] } } }));
    const json = JSON.stringify(sensors);
    expect(json).not.toContain(OTHER_TEAM);
    expect(json).not.toContain(ARCHIVED);
  });

  it('?deviceId filtra; un dispositivo de otro equipo o archivado → 404', async () => {
    const { service } = setup();
    expect((await service.sensors('u1', HIOKI)).map((s) => s.sensorId)).toEqual([`${HIOKI}:hioki-im3570-lcr`]);
    expect(await service.sensors('u1', MUX)).toEqual([]);
    await expect(service.sensors('u1', OTHER_TEAM)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.actuators('u1', ARCHIVED)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('actuadores Tabla 19 por instancia', async () => {
    const actuators = await setup().service.actuators('u1');
    expect(actuators).toHaveLength(1);
    expect(actuators[0]).toMatchObject({
      actuatorId: `${MUX}:kronos-mux-16-channel`,
      protocol: 'http',
      'x-deviceProtocol': 'http',
      inputType: 'integer',
      actuatorConfiguration: [],
      accessMode: { accessModeType: 'pull' },
      actuatorValues: [{ name: 'channel', rangeMinimum: 1, rangeMaximum: 16, rangeStep: 1 }],
    });
    for (const f of ['actuatorId', 'fullName', 'description', 'protocol', 'inputType', 'actuatorValues', 'actuatorConfiguration', 'accessMode']) {
      expect(actuators[0]).toHaveProperty(f);
    }
  });
});

describe('LaasInstancesService: getSensorData', () => {
  const stored = {
    id: 7, taskId: 3, takenAt: new Date('2026-11-02T08:00:00Z'),
    acquisition: { kind: 'sweep', variable: { name: 'frequency', unit: 'Hz', label: 'Frecuencia' } },
    sensorValues: [{ name: 'z', unit: 'Ω' }],
    data: [
      { x: 100, values: { z: [1, 2, 3, ...Array(13).fill(0)] } },
      { x: 200, values: { z: [4, 5, 6, ...Array(13).fill(0)] } },
    ],
    measurementChannels: [{ channelNumber: 3 }, { channelNumber: 1 }],
  };

  it('última medición del equipo + sensor (de cualquier tarea del equipo), con todos sus canales', async () => {
    const { service, prisma } = setup();
    prisma.measurement.findFirst.mockResolvedValue(stored);
    await expect(service.sensorData('u1', `${HIOKI}:hioki-im3570-lcr`)).resolves.toEqual({
      sensorId: `${HIOKI}:hioki-im3570-lcr`,
      measurementId: 7,
      taskId: 3,
      lastMeasured: '2026-11-02T08:00:00.000Z',
      acquisition: stored.acquisition,
      sensorValues: [{ name: 'z', unit: 'Ω' }],
      channels: [
        { channel: 1, points: [{ x: 100, values: { z: 1 } }, { x: 200, values: { z: 4 } }] },
        { channel: 3, points: [{ x: 100, values: { z: 3 } }, { x: 200, values: { z: 6 } }] },
      ],
    });
    const { where, orderBy } = (prisma.measurement.findFirst.mock.calls[0] as any)[0];
    expect(where).toEqual({ sensorDeviceId: HIOKI, sensorId: 'hioki-im3570-lcr', task: { project: { team: 't1' } } });
    expect(orderBy[0]).toEqual({ takenAt: { sort: 'desc', nulls: 'last' } });
  });

  it('taskId filtra (y debe ser del equipo de trabajo)', async () => {
    const { service, prisma, teamScope } = setup();
    prisma.measurement.findFirst.mockResolvedValue(stored);
    await service.sensorData('u1', `${HIOKI}:hioki-im3570-lcr`, 3);
    expect(teamScope.assertTaskInTeam).toHaveBeenCalledWith('u1', 3);
    expect((prisma.measurement.findFirst.mock.calls[0] as any)[0].where.taskId).toBe(3);
    await expect(service.sensorData('u1', `${HIOKI}:hioki-im3570-lcr`, 999)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404 sin lecturas; 404 sensor inexistente, de otro equipo o archivado; 400 id inválido', async () => {
    const { service } = setup();
    await expect(service.sensorData('u1', `${HIOKI}:hioki-im3570-lcr`)).rejects.toThrow(new NotFoundException('No hay lecturas de este sensor'));
    await expect(service.sensorData('u1', `${HIOKI}:otro`)).rejects.toThrow(new NotFoundException('Sensor no encontrado'));
    await expect(service.sensorData('u1', `${MUX}:kronos-mux-16-channel`)).rejects.toThrow(new NotFoundException('Sensor no encontrado'));
    await expect(service.sensorData('u1', `${OTHER_TEAM}:hioki-im3570-lcr`)).rejects.toThrow(new NotFoundException('Sensor no encontrado'));
    await expect(service.sensorData('u1', `${ARCHIVED}:hioki-im3570-lcr`)).rejects.toThrow(new NotFoundException('Sensor no encontrado'));
    await expect(service.sensorData('u1', 'hioki-im3570-lcr')).rejects.toThrow(new BadRequestException('Identificador LaaS inválido'));
  });
});

describe('LaasInstancesService: getSensorData fresh=true', () => {
  const resolved = (sensorDeviceId: string, sensorName = 'Hioki A') => ({
    preference: {
      sensorDeviceId,
      sensorDevice: { id: sensorDeviceId, name: sensorName },
      ranges: [{ start: 100, stop: 1000, points: 10, scale: 'LOG' }],
    },
    channelRange: { min: 1, max: 4 },
  });

  it('encola por la admisión existente con los rangos de la tarea y todos los canales del experimento → { jobId, taskId, estimatedSeconds }', async () => {
    const { service, experimentConfig, scheduling } = setup();
    experimentConfig.resolve.mockResolvedValue(resolved(HIOKI));
    await expect(service.requestFresh('u1', `${HIOKI}:hioki-im3570-lcr`, 3, undefined)).resolves.toEqual({ jobId: '42', taskId: 3, estimatedSeconds: 33 });
    expect(scheduling.requestMeasurement).toHaveBeenCalledWith(3, 'u1', {
      ranges: [{ start: 100, stop: 1000, points: 10, scale: 'LOG' }],
      selectedChannels: [1, 2, 3, 4],
      jobId: expect.stringMatching(/^3-\d+$/),
    });
  });

  it('canales pedidos se respetan; errores de admisión (409) se propagan', async () => {
    const { service, experimentConfig, scheduling } = setup();
    experimentConfig.resolve.mockResolvedValue(resolved(HIOKI));
    await service.requestFresh('u1', `${HIOKI}:hioki-im3570-lcr`, 3, [2]);
    expect((scheduling.requestMeasurement.mock.calls[0] as any)[2].selectedChannels).toEqual([2]);
    scheduling.requestMeasurement.mockRejectedValue(new ConflictException({ error: 'queue_full' }));
    await expect(service.requestFresh('u1', `${HIOKI}:hioki-im3570-lcr`, 3, [2])).rejects.toBeInstanceOf(ConflictException);
  });

  it('400 si el sensor de la tarea es otro equipo', async () => {
    const { service, experimentConfig, scheduling } = setup();
    experimentConfig.resolve.mockResolvedValue(resolved(OTHER_HIOKI, 'Hioki A2'));
    await expect(service.requestFresh('u1', `${HIOKI}:hioki-im3570-lcr`, 3, undefined)).rejects.toThrow(
      new BadRequestException('La tarea no mide con este sensor: su equipo de medición es "Hioki A2"'),
    );
    expect(scheduling.requestMeasurement).not.toHaveBeenCalled();
  });

  it('404 si el sensor es de otro equipo de trabajo (o la tarea); 400 sin taskId o sin equipo asignado', async () => {
    const { service, experimentConfig, scheduling } = setup();
    await expect(service.requestFresh('u1', `${OTHER_TEAM}:hioki-im3570-lcr`, 3, undefined)).rejects.toThrow(new NotFoundException('Sensor no encontrado'));
    await expect(service.requestFresh('u1', `${HIOKI}:hioki-im3570-lcr`, 999, undefined)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.requestFresh('u1', `${HIOKI}:hioki-im3570-lcr`, undefined, undefined)).rejects.toBeInstanceOf(BadRequestException);
    experimentConfig.resolve.mockResolvedValue(null);
    await expect(service.requestFresh('u1', `${HIOKI}:hioki-im3570-lcr`, 3, undefined)).rejects.toBeInstanceOf(BadRequestException);
    expect(scheduling.requestMeasurement).not.toHaveBeenCalled();
  });
});

describe('LaasInstancesService: setActuatorData', () => {
  const ID = `${MUX}:kronos-mux-16-channel`;

  it('delega en el worker (set-actuator-data) y responde { actuatorId, values, appliedAt }', async () => {
    const { service, deviceOps } = setup();
    const res = await service.setActuatorData('u1', ID, { channel: 5 });
    expect(res).toEqual({ actuatorId: ID, values: { channel: 5 }, appliedAt: expect.any(String) });
    expect(Number.isNaN(Date.parse(res.appliedAt))).toBe(false);
    expect(deviceOps.request).toHaveBeenCalledWith('set-actuator-data', { deviceId: MUX, actuatorId: 'kronos-mux-16-channel', values: { channel: 5 } }, 25000);
  });

  it('400 fuera de rango (validado por el worker)', async () => {
    const { service, deviceOps } = setup();
    deviceOps.request.mockRejectedValue(new DeviceOpFailedError('"channel" debe estar entre 1 y 16'));
    await expect(service.setActuatorData('u1', ID, { channel: 17 })).rejects.toThrow(new BadRequestException('"channel" debe estar entre 1 y 16'));
  });

  it('400 cuerpo inválido (sin llegar al worker)', async () => {
    const { service, deviceOps } = setup();
    for (const values of [{}, { channel: 'x' }, { channel: NaN }, [], null]) {
      await expect(service.setActuatorData('u1', ID, values)).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(deviceOps.request).not.toHaveBeenCalled();
  });

  it('409 ocupado (camino rápido y lock del worker)', async () => {
    const { service, deviceOps, deviceState } = setup();
    deviceState.isBusy.mockResolvedValueOnce(true);
    await expect(service.setActuatorData('u1', ID, { channel: 2 })).rejects.toThrow(new ConflictException(deviceBusyMessage('MUX A')));
    expect(deviceOps.request).not.toHaveBeenCalled();
    deviceOps.request.mockRejectedValue(new DeviceOpFailedError(deviceBusyMessage('MUX A')));
    await expect(service.setActuatorData('u1', ID, { channel: 2 })).rejects.toBeInstanceOf(ConflictException);
  });

  it('504 si el laboratorio no responde', async () => {
    const { service, deviceOps } = setup();
    deviceOps.request.mockRejectedValue(new DeviceOpTimeoutError('timeout'));
    await expect(service.setActuatorData('u1', ID, { channel: 2 })).rejects.toThrow(new GatewayTimeoutException('El laboratorio no respondió a tiempo'));
  });

  it('404 actuador inexistente o de otro equipo', async () => {
    const { service } = setup();
    await expect(service.setActuatorData('u1', `${MUX}:otro`, { channel: 2 })).rejects.toThrow(new NotFoundException('Actuador no encontrado'));
    await expect(service.setActuatorData('u1', `${HIOKI}:kronos-mux-16-channel`, { channel: 2 })).rejects.toThrow(new NotFoundException('Actuador no encontrado'));
    await expect(service.setActuatorData('u1', `${OTHER_TEAM}:kronos-mux-16-channel`, { channel: 2 })).rejects.toBeInstanceOf(NotFoundException);
  });
});
