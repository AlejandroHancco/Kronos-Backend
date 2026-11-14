import { AgilentE4402bDriver, e4402bSweepCommands, parseTrace } from './agilent-e4402b.driver';
import { AGILENT_E4402B } from '@app/laas-catalog';
import type { ScpiTransport } from '../../transports/scpi-transport';

const cfg = { transport: 'prologix', gpibAddress: 18, resolutionBandwidth: 'AUTO', referenceLevel: 0 };
const ctx = { id: 'd', name: 'ESA', ip: '10.0.0.5', configuration: cfg };
const req = { kind: 'sweep' as const, start: 9000, stop: 1_000_009_000, points: 401, scale: 'LIN' as const };

function fakeTransport(trace: string, opts: { failOpc?: boolean; err?: string; sweepTime?: string | Error } = {}) {
  const log: string[] = [];
  const timeouts: Record<string, number | undefined> = {};
  let closed = false;
  const t: ScpiTransport = {
    write: async (c) => { log.push(c); },
    query: async (c, timeoutMs) => {
      log.push(c);
      timeouts[c] = timeoutMs;
      if (c === ':SWE:TIME?') {
        if (opts.sweepTime instanceof Error) throw opts.sweepTime;
        return opts.sweepTime ?? '+5.00000000E-002';
      }
      if (c.startsWith(':INIT:IMM')) { if (opts.failOpc) throw new Error('Tiempo de espera agotado esperando respuesta'); return '1'; }
      if (c.startsWith(':TRAC?')) return trace;
      if (c === ':SYST:ERR?') return opts.err ?? '+0,"No error"';
      return '';
    },
    close: () => { closed = true; },
  };
  return { t, log, timeouts, closed: () => closed };
}

const trace401 = Array.from({ length: 401 }, (_, i) => (-90 + (i % 7)).toFixed(2)).join(',');

describe('agilent-e4402b', () => {
  it('comandos del barrido con RBW automático; :SWE:POIN siempre (el panel puede tener otro valor)', () => {
    expect(e4402bSweepCommands(req, cfg)).toEqual([
      ':INIT:CONT OFF', ':FREQ:STAR 9000', ':FREQ:STOP 1000009000', ':SWE:POIN 401', ':BAND:AUTO ON', ':DISP:WIND:TRAC:Y:RLEV 0', ':FORM ASC',
    ]);
  });
  it('RBW manual', () => {
    expect(e4402bSweepCommands(req, { ...cfg, resolutionBandwidth: '30000' })).toContain(':BAND 30000');
  });
  it('parseTrace', () => expect(parseTrace('-90.1, -80,  -70.5\n')).toEqual([-90.1, -80, -70.5]));

  it('mide: x lineal y amplitud en dBm', async () => {
    const p = new AgilentE4402bDriver();
    const f = fakeTransport(trace401);
    p.openTransport = async () => f.t;
    const points = await p.getSensorData(ctx, req);
    expect(points).toHaveLength(401);
    expect(points[0]).toEqual({ x: 9000, values: { amplitude: -90 } });
    expect(points[400].x).toBe(1_000_009_000);
    expect(points[200].x).toBe(500_009_000);
    expect(f.log.slice(-3)).toEqual([':SWE:TIME?', ':INIT:IMM;*OPC?', ':TRAC? TRACE1']);
    expect(f.log).toEqual([...e4402bSweepCommands(req, cfg), ':SWE:TIME?', ':INIT:IMM;*OPC?', ':TRAC? TRACE1']);
    expect(f.closed()).toBe(true);
  });

  describe('timeout de *OPC? desde :SWE:TIME? (segundos)', () => {
    async function opcTimeout(sweepTime: string | Error) {
      const p = new AgilentE4402bDriver();
      const f = fakeTransport(trace401, { sweepTime });
      p.openTransport = async () => f.t;
      await p.getSensorData(ctx, req);
      return f.timeouts[':INIT:IMM;*OPC?'];
    }
    it('barrido largo: 3 × tiempo de barrido + 5 s', async () => {
      expect(await opcTimeout('+2.00000000E+001')).toBe(65_000); // 20 s → 3 × 20 000 + 5 000
    });
    it('barrido corto: al menos 10 s', async () => {
      expect(await opcTimeout('+5.00000000E-002')).toBe(10_000);
    });
    it('respuesta no numérica: cae a la estimación por puntos', async () => {
      expect(await opcTimeout('garbage')).toBe(new AgilentE4402bDriver().opcTimeoutMs(401));
    });
    it('la consulta falla: cae a la estimación por puntos', async () => {
      expect(await opcTimeout(new Error('sin respuesta'))).toBe(new AgilentE4402bDriver().opcTimeoutMs(401));
    });
  });
  it('falla si la traza no tiene los puntos pedidos', async () => {
    const p = new AgilentE4402bDriver();
    p.openTransport = async () => fakeTransport('-90,-91').t;
    await expect(p.getSensorData(ctx, req)).rejects.toThrow('El E4402B devolvió 2 puntos; se esperaban 401');
  });
  it('agrega :SYST:ERR? al error', async () => {
    const p = new AgilentE4402bDriver();
    const f = fakeTransport(trace401, { failOpc: true, err: '-222,"Data out of range"' });
    p.openTransport = async () => f.t;
    await expect(p.getSensorData(ctx, req)).rejects.toThrow('Tiempo de espera agotado esperando respuesta (equipo: -222,"Data out of range")');
    expect(f.closed()).toBe(true);
  });
  it('rechaza lecturas puntuales y equipos sin IP', async () => {
    const p = new AgilentE4402bDriver();
    await expect(p.getSensorData(ctx, { kind: 'single' })).rejects.toThrow('solo hace barridos');
    await expect(p.getSensorData({ ...ctx, ip: null }, req)).rejects.toThrow('no tiene IP configurada');
  });
  it('validateConfiguration', () => {
    expect(AGILENT_E4402B.validateConfiguration!({ ...cfg, defaultStartFreq: 1e6, defaultStopFreq: 1e5 })).toMatch(/menor/);
    expect(AGILENT_E4402B.validateConfiguration!({ ...cfg, resolutionBandwidth: 'rapido' })).toMatch(/RBW/);
    expect(AGILENT_E4402B.validateConfiguration!({ ...cfg, resolutionBandwidth: '500' })).toMatch(/RBW/);
    expect(AGILENT_E4402B.validateConfiguration!({ ...cfg, resolutionBandwidth: '30000' })).toBeNull();
  });
  it('timeout de *OPC? según el barrido estimado', () => {
    expect(new AgilentE4402bDriver().opcTimeoutMs(401)).toBe(10_000); // 401 × 5 ms × 3 = 6 s < 10 s
  });
});
