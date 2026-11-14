jest.mock('axios');
import axios from 'axios';
import { KronosMux16Plugin } from './kronos-mux-16.plugin';

const get = axios.get as jest.Mock;
const dev = { id: 'm1', name: 'MUX', ip: '10.0.0.2', configuration: {} };

describe('KronosMux16Plugin', () => {
  beforeEach(() => get.mockReset());

  it('se describe como selector de canal 1–16', () => {
    const d = new KronosMux16Plugin().describe();
    expect(KronosMux16Plugin.DEVICE_TYPE).toBe('kronos-mux-16');
    expect(d.channelSelector).toEqual({ actuatorId: 'kronos-mux-16-channel', valueName: 'channel' });
    expect(d.sensors).toEqual([]);
  });

  it('setActuatorData envía GET /?orden=N y recuerda el canal', async () => {
    get.mockResolvedValue({ status: 200 });
    const p = new KronosMux16Plugin();
    await p.setActuatorData(dev, 'kronos-mux-16-channel', { channel: 5 });
    expect(get).toHaveBeenCalledWith('http://10.0.0.2/?orden=5', expect.objectContaining({ timeout: 5000 }));
    expect(p.lastChannel('m1')).toBe(5);
    await expect(p.readLiveConfiguration(dev)).resolves.toEqual({ channel: 5 });
  });

  it('rechaza canal fuera de rango o actuator desconocido sin llamar al MUX', async () => {
    const p = new KronosMux16Plugin();
    await expect(p.setActuatorData(dev, 'kronos-mux-16-channel', { channel: 17 })).rejects.toThrow(/fuera de rango/);
    await expect(p.setActuatorData(dev, 'otro', { channel: 1 })).rejects.toThrow(/desconocido/);
    expect(get).not.toHaveBeenCalled();
  });

  it('3 intentos y error en español', async () => {
    get.mockRejectedValue(new Error('ECONNREFUSED'));
    const p = new KronosMux16Plugin();
    p.retryDelayMs = 0;
    await expect(p.setActuatorData(dev, 'kronos-mux-16-channel', { channel: 2 })).rejects.toThrow(
      'No se pudo activar el canal 2 del MUX: ECONNREFUSED',
    );
    expect(get).toHaveBeenCalledTimes(3);
    await expect(p.readLiveConfiguration(dev)).resolves.toEqual({ channel: null });
  });

  it('applyLiveConfiguration activa el canal pedido', async () => {
    get.mockResolvedValue({ status: 200 });
    const p = new KronosMux16Plugin();
    await p.applyLiveConfiguration(dev, { channel: 3 });
    expect(get).toHaveBeenCalledWith('http://10.0.0.2/?orden=3', expect.anything());
    expect(p.lastChannel('m1')).toBe(3);
  });

  it('testConnection: false sin IP; GET http://<ip> con 2 s', async () => {
    const p = new KronosMux16Plugin();
    await expect(p.testConnection({ ip: null })).resolves.toBe(false);
    get.mockResolvedValue({ status: 200 });
    await expect(p.testConnection({ ip: '10.0.0.2' })).resolves.toBe(true);
    expect(get).toHaveBeenCalledWith('http://10.0.0.2', { timeout: 2000 });
    get.mockRejectedValue(new Error('x'));
    await expect(p.testConnection({ ip: '10.0.0.2' })).resolves.toBe(false);
  });
});
