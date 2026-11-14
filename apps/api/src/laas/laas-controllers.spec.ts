import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DEVICE_MODELS, LaasCatalog, experimentCatalog } from '@app/laas-catalog';
import { ExperimentCatalogService } from '../device-plugins/core/experiment-catalog.service';
import { LaasSensorsController, parseChannels } from './laas-sensors.controller';
import { LaasExperimentsController } from './laas-experiments.controller';

const SENSOR = '11111111-1111-4111-8111-111111111111:hioki-im3570-lcr';

describe('LaasSensorsController.getSensorData', () => {
  function setup(canExecute = true) {
    const instances = {
      sensorData: jest.fn(async () => ({ measurementId: 1 })),
      requestFresh: jest.fn(async () => ({ jobId: '42', taskId: 3, estimatedSeconds: 10 })),
    };
    const permissions = { hasPermission: jest.fn(async () => canExecute) };
    const res = { status: jest.fn() };
    return { ctrl: new LaasSensorsController(instances as any, permissions as any), instances, permissions, res };
  }
  const user = { id: 'u1' } as any;

  it('sin fresh: última lectura (200)', async () => {
    const { ctrl, instances, res } = setup();
    await expect(ctrl.getSensorData(SENSOR, 3, undefined, undefined, user, res as any)).resolves.toEqual({ measurementId: 1 });
    expect(instances.sensorData).toHaveBeenCalledWith('u1', SENSOR, 3);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('fresh=true: exige measurement:execute y responde 202 con { jobId, taskId, estimatedSeconds }', async () => {
    const { ctrl, instances, permissions, res } = setup();
    await expect(ctrl.getSensorData(SENSOR, 3, 'true', '1,2', user, res as any)).resolves.toEqual({ jobId: '42', taskId: 3, estimatedSeconds: 10 });
    expect(permissions.hasPermission).toHaveBeenCalledWith('u1', 'measurement:execute');
    expect(instances.requestFresh).toHaveBeenCalledWith('u1', SENSOR, 3, [1, 2]);
    expect(res.status).toHaveBeenCalledWith(202);
  });

  it('fresh=true sin measurement:execute → 403', async () => {
    const { ctrl, instances, res } = setup(false);
    await expect(ctrl.getSensorData(SENSOR, 3, 'true', undefined, user, res as any)).rejects.toBeInstanceOf(ForbiddenException);
    expect(instances.requestFresh).not.toHaveBeenCalled();
  });

  it('fresh=true de un sensor de otro equipo → 404 (sin 202)', async () => {
    const { ctrl, instances, res } = setup();
    instances.requestFresh.mockRejectedValue(new NotFoundException('Sensor no encontrado'));
    await expect(ctrl.getSensorData(SENSOR, 3, 'true', undefined, user, res as any)).rejects.toBeInstanceOf(NotFoundException);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('parseChannels', () => {
    expect(parseChannels(undefined)).toBeUndefined();
    expect(parseChannels('')).toBeUndefined();
    expect(parseChannels('1, 2,2')).toEqual([1, 2]);
    for (const bad of ['0', 'a', '1,,2', '1.5', '-1']) expect(() => parseChannels(bad)).toThrow(BadRequestException);
  });
});

describe('LaasExperimentsController (Tabla 20)', () => {
  const catalog = new LaasCatalog(DEVICE_MODELS);
  const user = { id: 'u1' } as any;
  const HIOKI_DEV = '11111111-1111-4111-8111-111111111111';
  const MUX_DEV = '22222222-2222-4222-8222-222222222222';

  function setup() {
    const experiments = {
      catalog: jest.fn(() => experimentCatalog(catalog.catalog())),
      forProject: jest.fn(async () =>
        experimentCatalog(catalog.catalog()).map((e) => ({
          ...e,
          sensorDevices: e.sensorType === 'hioki-im3570' ? [{ id: HIOKI_DEV, name: 'Hioki', ip: '10.0.0.5', status: 'online' }] : [],
          channelSelectorDevices: e.channelSelectorType === 'kronos-mux-16' ? [{ id: MUX_DEV, name: 'MUX', ip: '10.0.0.2', status: 'online' }] : [],
          available: e.sensorType === 'hioki-im3570',
        })),
      ),
    };
    return { ctrl: new LaasExperimentsController(experiments as unknown as ExperimentCatalogService, catalog), experiments };
  }

  it('sin projectId: experimentos del catálogo con ids de catálogo', async () => {
    const list = await setup().ctrl.getExperiment(undefined, user);
    const e = list.find((x) => x.experimentId === 'hioki-im3570+kronos-mux-16')!;
    expect(Object.keys(e)).toEqual(expect.arrayContaining(['experimentId', 'fullName', 'description', 'sensors', 'actuators']));
    expect(e.sensors).toEqual(['hioki-im3570-lcr']);
    expect(e.actuators).toEqual(['kronos-mux-16-channel']);
    expect(e['x-channelRange']).toEqual({ min: 1, max: 16 });
    expect(e).not.toHaveProperty('x-available');
    expect(list.find((x) => x.experimentId === 'hioki-im3570')!.actuators).toEqual([]);
    expect(list).toHaveLength(experimentCatalog(catalog.catalog()).length);
  });

  it('con projectId: ids LaaS de las instancias del proyecto', async () => {
    const { ctrl, experiments } = setup();
    const list = await ctrl.getExperiment('99999999-9999-4999-8999-999999999999', user);
    expect(experiments.forProject).toHaveBeenCalledWith('99999999-9999-4999-8999-999999999999', 'u1');
    const e = list.find((x) => x.experimentId === 'hioki-im3570+kronos-mux-16')!;
    expect(e.sensors).toEqual([`${HIOKI_DEV}:hioki-im3570-lcr`]);
    expect(e.actuators).toEqual([`${MUX_DEV}:kronos-mux-16-channel`]);
    expect(e['x-available']).toBe(true);
    const sim = list.find((x) => x.experimentId === 'sim-impedance')!;
    expect(sim).toMatchObject({ sensors: [], actuators: [], 'x-available': false });
  });
});
