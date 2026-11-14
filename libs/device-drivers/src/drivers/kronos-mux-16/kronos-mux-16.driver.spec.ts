jest.mock('axios');
import axios from 'axios';
import { KRONOS_MUX_16 } from '@app/laas-catalog';
import { KronosMux16Driver } from './kronos-mux-16.driver';

const get = axios.get as jest.Mock;
const dev = { id: 'm1', name: 'MUX', ip: '10.0.0.2', configuration: {} };

describe('KronosMux16Driver', () => {
  beforeEach(() => get.mockReset());

  it('se describe como selector de canal 1–16', () => {
    const d = KRONOS_MUX_16.description;
    expect(new KronosMux16Driver().deviceType).toBe('kronos-mux-16');
    expect(d.channelSelector).toEqual({ actuatorId: 'kronos-mux-16-channel', valueName: 'channel' });
    expect(d.sensors).toEqual([]);
  });

  it('setActuatorData envía GET /?orden=N', async () => {
    get.mockResolvedValue({ status: 200 });
    const p = new KronosMux16Driver();
    await p.setActuatorData(dev, 'kronos-mux-16-channel', { channel: 5 });
    expect(get).toHaveBeenCalledWith('http://10.0.0.2/?orden=5', expect.objectContaining({ timeout: 5000 }));
  });

  it('sin estado: no recuerda el último canal ni implementa readLiveConfiguration', async () => {
    get.mockResolvedValue({ status: 200 });
    const p = new KronosMux16Driver() as KronosMux16Driver & Record<string, unknown>;
    await p.setActuatorData(dev, 'kronos-mux-16-channel', { channel: 5 });
    expect(p.readLiveConfiguration).toBeUndefined();
    expect(p.lastChannel).toBeUndefined();
    expect(Object.values(p).some((v) => v instanceof Map)).toBe(false);
  });

  it('rechaza canal fuera de rango o actuator desconocido sin llamar al MUX', async () => {
    const p = new KronosMux16Driver();
    await expect(p.setActuatorData(dev, 'kronos-mux-16-channel', { channel: 17 })).rejects.toThrow(/fuera de rango/);
    await expect(p.setActuatorData(dev, 'otro', { channel: 1 })).rejects.toThrow(/desconocido/);
    expect(get).not.toHaveBeenCalled();
  });

  it('3 intentos y error en español', async () => {
    get.mockRejectedValue(new Error('ECONNREFUSED'));
    const p = new KronosMux16Driver();
    p.retryDelayMs = 0;
    await expect(p.setActuatorData(dev, 'kronos-mux-16-channel', { channel: 2 })).rejects.toThrow(
      'No se pudo activar el canal 2 del MUX: ECONNREFUSED',
    );
    expect(get).toHaveBeenCalledTimes(3);
  });

  it('applyLiveConfiguration activa el canal pedido', async () => {
    get.mockResolvedValue({ status: 200 });
    const p = new KronosMux16Driver();
    await p.applyLiveConfiguration(dev, { channel: 3 });
    expect(get).toHaveBeenCalledWith('http://10.0.0.2/?orden=3', expect.anything());
  });

  it('testConnection: false sin IP; GET http://<ip> con 2 s', async () => {
    const p = new KronosMux16Driver();
    await expect(p.testConnection({ ip: null })).resolves.toBe(false);
    get.mockResolvedValue({ status: 200 });
    await expect(p.testConnection({ ip: '10.0.0.2' })).resolves.toBe(true);
    expect(get).toHaveBeenCalledWith('http://10.0.0.2', { timeout: 2000 });
    get.mockRejectedValue(new Error('x'));
    await expect(p.testConnection({ ip: '10.0.0.2' })).resolves.toBe(false);
  });
});
