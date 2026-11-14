import { HiokiIm3570Plugin } from './hioki-im3570.plugin';
import { effectiveConfiguration } from '../../core/configuration';
import type { ScpiTransport } from '../../core/transports/scpi-transport';
import { RawTcpScpi } from '../../core/transports/raw-tcp-scpi';

/** Transporte falso que registra write/query y permite forzar un rechazo en query. */
function fakeTransport(opts: { queryResult?: string; queryError?: Error } = {}) {
  const calls: Array<{ op: 'write' | 'query'; command: string; timeoutMs?: number }> = [];
  let closed = false;
  const transport: ScpiTransport = {
    write: async (command: string) => {
      calls.push({ op: 'write', command });
    },
    query: async (command: string, timeoutMs?: number) => {
      calls.push({ op: 'query', command, timeoutMs });
      if (opts.queryError) throw opts.queryError;
      return opts.queryResult ?? '';
    },
    close: () => {
      closed = true;
    },
  };
  return { transport, calls, isClosed: () => closed };
}

describe('HiokiIm3570Plugin', () => {
  const plugin = new HiokiIm3570Plugin();
  const d = plugin.describe();

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('se describe como sensor hioki-im3570 sin actuators, con g y b en S', () => {
    expect(HiokiIm3570Plugin.DEVICE_TYPE).toBe('hioki-im3570');
    expect(d).toMatchObject({
      deviceType: 'hioki-im3570', shortName: 'Hioki IM3570', actuators: [], connection: { requiresIp: true, defaultPort: 3570 },
    });
    expect(d.channelSelector).toBeUndefined();
    expect(d.sensors[0].sensorValues.map((v) => [v.name, v.unit])).toEqual([['g', 'S'], ['b', 'S']]);
  });

  it('declara 6 parámetros de configuración', () => {
    expect(d.configuration.map((p) => p.name)).toEqual([
      'mode', 'parameters', 'defaultStartFreq', 'defaultStopFreq', 'defaultPoints', 'defaultSweepType',
    ]);
  });

  it('los valores por defecto de la configuración caen dentro de lo declarado en acquisition', () => {
    const acquisition = d.sensors[0].acquisition;
    if (acquisition.kind !== 'sweep') throw new Error('se esperaba un sensor sweep');
    const byName = Object.fromEntries(d.configuration.map((p) => [p.name, p]));
    expect(byName.defaultStartFreq.rangeMinimum).toBeGreaterThanOrEqual(acquisition.variable.rangeMinimum);
    expect(byName.defaultStartFreq.rangeMaximum).toBeLessThanOrEqual(acquisition.variable.rangeMaximum);
    expect(byName.defaultStopFreq.rangeMinimum).toBeGreaterThanOrEqual(acquisition.variable.rangeMinimum);
    expect(byName.defaultStopFreq.rangeMaximum).toBeLessThanOrEqual(acquisition.variable.rangeMaximum);
    expect(byName.defaultPoints.rangeMinimum).toBeGreaterThanOrEqual(acquisition.points.minimum);
    expect(byName.defaultPoints.rangeMaximum).toBeLessThanOrEqual(acquisition.points.maximum);
    for (const value of byName.defaultSweepType.allowedValues!) {
      expect(acquisition.scales).toContain(value);
    }
  });

  it('validateConfiguration exige frecuencia inicial < final', () => {
    const cfg = effectiveConfiguration(d.configuration, {});
    expect(plugin.validateConfiguration(cfg)).toBeNull();
    expect(plugin.validateConfiguration({ ...cfg, defaultStartFreq: 10, defaultStopFreq: 5 })).toBe(
      '"Frecuencia inicial por defecto" debe ser menor que "Frecuencia final por defecto"',
    );
  });

  it('testConnection sin IP es false sin abrir socket', async () => {
    await expect(plugin.testConnection({ ip: null })).resolves.toBe(false);
  });

  it('getSensorData sin IP falla con un mensaje claro (no intenta localhost)', async () => {
    await expect(
      plugin.getSensorData({ id: 'h', name: 'Hioki lab', ip: null, configuration: {} }, { kind: 'sweep', start: 1, stop: 2, points: 2, scale: 'LOG' }),
    ).rejects.toThrow('El equipo "Hioki lab" no tiene IP configurada');
  });

  it('getSensorData rechaza lecturas puntuales', async () => {
    await expect(
      plugin.getSensorData({ id: 'h', name: 'Hioki lab', ip: '10.0.0.5', configuration: {} }, { kind: 'single' }),
    ).rejects.toThrow('El Hioki IM3570 solo hace barridos');
  });

  it('getSensorData envía el setup, consulta :MEASure? y parsea la respuesta', async () => {
    const { transport, calls, isClosed } = fakeTransport({ queryResult: '9000,1.5,2.5,10000,1.6,2.6' });
    jest.spyOn(plugin, 'openTransport').mockResolvedValue(transport);

    const points = await plugin.getSensorData(
      { id: 'h', name: 'Hioki lab', ip: '10.0.0.5', configuration: {} },
      { kind: 'sweep', start: 9000, stop: 10000, points: 2, scale: 'LOG' },
    );

    expect(plugin.openTransport).toHaveBeenCalledWith('10.0.0.5');
    expect(calls.slice(0, 6)).toEqual([
      { op: 'write', command: ':MODE ANALyzer' },
      { op: 'write', command: ':SWEep:TRIGger SEQuential' },
      { op: 'write', command: ':LIST:STARt:STOP 9000,10000,2,LOG' },
      { op: 'write', command: ':PARameter1 G' },
      { op: 'write', command: ':PARameter3 B' },
      { op: 'write', command: '*TRG' },
    ]);
    expect(calls[6]).toEqual({ op: 'query', command: ':MEASure?', timeoutMs: 55000 });
    expect(points).toEqual([
      { x: 9000, values: { g: 1.5, b: 2.5 } },
      { x: 10000, values: { g: 1.6, b: 2.6 } },
    ]);
    expect(isClosed()).toBe(true);
  });

  it('openTransport abre RawTcpScpi con las opciones fijadas (puerto, terminador, demora de escritura, timeout de conexión)', async () => {
    const openSpy = jest.spyOn(RawTcpScpi, 'open').mockResolvedValue({ write: jest.fn(), query: jest.fn(), close: jest.fn() } as unknown as RawTcpScpi);

    await plugin.openTransport('10.0.0.5');

    expect(openSpy).toHaveBeenCalledWith('10.0.0.5', 3570, { terminator: '\r\n', writeDelayMs: 100, connectTimeoutMs: 5000 });
  });

  it('openTransport: error de conexión en español (como el E4402B)', async () => {
    jest.spyOn(RawTcpScpi, 'open').mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:3570'));
    await expect(plugin.openTransport('10.0.0.5')).rejects.toThrow('Sin respuesta del Hioki IM3570 en 10.0.0.5:3570');
  });

  it('getSensorData cierra el transporte aunque query rechace', async () => {
    const { transport, isClosed } = fakeTransport({ queryError: new Error('Tiempo de espera agotado esperando respuesta') });
    jest.spyOn(plugin, 'openTransport').mockResolvedValue(transport);

    await expect(
      plugin.getSensorData(
        { id: 'h', name: 'Hioki lab', ip: '10.0.0.5', configuration: {} },
        { kind: 'sweep', start: 1, stop: 2, points: 2, scale: 'LOG' },
      ),
    ).rejects.toThrow('Tiempo de espera agotado esperando respuesta');
    expect(isClosed()).toBe(true);
  });
});
