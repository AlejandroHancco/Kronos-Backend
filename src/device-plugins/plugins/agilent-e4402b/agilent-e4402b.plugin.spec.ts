import { AgilentE4402bPlugin, e4402bSweepCommands, parseTrace } from './agilent-e4402b.plugin';
import type { ScpiTransport } from '../../core/transports/scpi-transport';

const cfg = { transport: 'prologix', gpibAddress: 18, resolutionBandwidth: 'AUTO', referenceLevel: 0 };
const ctx = { id: 'd', name: 'ESA', ip: '10.0.0.5', configuration: cfg };
const req = { kind: 'sweep' as const, start: 9000, stop: 1_000_009_000, points: 401, scale: 'LIN' as const };

function fakeTransport(trace: string, opts: { failOpc?: boolean; err?: string } = {}) {
  const log: string[] = [];
  let closed = false;
  const t: ScpiTransport = {
    write: async (c) => { log.push(c); },
    query: async (c) => {
      log.push(c);
      if (c.startsWith(':INIT:IMM')) { if (opts.failOpc) throw new Error('Tiempo de espera agotado esperando respuesta'); return '1'; }
      if (c.startsWith(':TRAC?')) return trace;
      if (c === ':SYST:ERR?') return opts.err ?? '+0,"No error"';
      return '';
    },
    close: () => { closed = true; },
  };
  return { t, log, closed: () => closed };
}

const trace401 = Array.from({ length: 401 }, (_, i) => (-90 + (i % 7)).toFixed(2)).join(',');

describe('agilent-e4402b', () => {
  it('comandos del barrido con RBW automático', () => {
    expect(e4402bSweepCommands(req, cfg)).toEqual([
      ':INIT:CONT OFF', ':FREQ:STAR 9000', ':FREQ:STOP 1000009000', ':BAND:AUTO ON', ':DISP:WIND:TRAC:Y:RLEV 0', ':FORM ASC',
    ]);
  });
  it('RBW manual', () => {
    expect(e4402bSweepCommands(req, { ...cfg, resolutionBandwidth: '30000' })).toContain(':BAND 30000');
  });
  it('parseTrace', () => expect(parseTrace('-90.1, -80,  -70.5\n')).toEqual([-90.1, -80, -70.5]));

  it('mide: x lineal y amplitud en dBm', async () => {
    const p = new AgilentE4402bPlugin();
    const f = fakeTransport(trace401);
    p.openTransport = async () => f.t;
    const points = await p.getSensorData(ctx, req);
    expect(points).toHaveLength(401);
    expect(points[0]).toEqual({ x: 9000, values: { amplitude: -90 } });
    expect(points[400].x).toBe(1_000_009_000);
    expect(points[200].x).toBe(500_009_000);
    expect(f.log.slice(-2)).toEqual([':INIT:IMM;*OPC?', ':TRAC? TRACE1']);
    expect(f.closed()).toBe(true);
  });
  it('falla si la traza no tiene los puntos pedidos', async () => {
    const p = new AgilentE4402bPlugin();
    p.openTransport = async () => fakeTransport('-90,-91').t;
    await expect(p.getSensorData(ctx, req)).rejects.toThrow('El E4402B devolvió 2 puntos; se esperaban 401');
  });
  it('agrega :SYST:ERR? al error', async () => {
    const p = new AgilentE4402bPlugin();
    const f = fakeTransport(trace401, { failOpc: true, err: '-222,"Data out of range"' });
    p.openTransport = async () => f.t;
    await expect(p.getSensorData(ctx, req)).rejects.toThrow('Tiempo de espera agotado esperando respuesta (equipo: -222,"Data out of range")');
    expect(f.closed()).toBe(true);
  });
  it('rechaza lecturas puntuales y equipos sin IP', async () => {
    const p = new AgilentE4402bPlugin();
    await expect(p.getSensorData(ctx, { kind: 'single' })).rejects.toThrow('solo hace barridos');
    await expect(p.getSensorData({ ...ctx, ip: null }, req)).rejects.toThrow('no tiene IP configurada');
  });
  it('validateConfiguration', () => {
    const p = new AgilentE4402bPlugin();
    expect(p.validateConfiguration({ ...cfg, defaultStartFreq: 1e6, defaultStopFreq: 1e5 })).toMatch(/menor/);
    expect(p.validateConfiguration({ ...cfg, resolutionBandwidth: 'rapido' })).toMatch(/RBW/);
    expect(p.validateConfiguration({ ...cfg, resolutionBandwidth: '500' })).toMatch(/RBW/);
    expect(p.validateConfiguration({ ...cfg, resolutionBandwidth: '30000' })).toBeNull();
  });
  it('timeout de *OPC? según el barrido estimado', () => {
    expect(new AgilentE4402bPlugin().opcTimeoutMs(401)).toBe(10_000); // 401 × 5 ms × 3 = 6 s < 10 s
  });
});
