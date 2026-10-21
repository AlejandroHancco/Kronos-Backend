import { BadRequestException } from '@nestjs/common';
import { ExperimentConfigService } from './experiment-config.service';
import { DevicePluginRegistry } from './device-plugin.registry';
import { HiokiIm3570Plugin } from '../plugins/hioki-im3570/hioki-im3570.plugin';
import { KronosMux16Plugin } from '../plugins/kronos-mux-16/kronos-mux-16.plugin';
import { SimulatedImpedancePlugin } from '../plugins/sim-impedance/sim-impedance.plugin';

const registry = new DevicePluginRegistry([new HiokiIm3570Plugin(), new KronosMux16Plugin(), new SimulatedImpedancePlugin()]);
const device = (id: string, type: string | null, configuration: unknown = null) =>
  ({ id, name: `Dev ${id}`, type, ip: '10.0.0.1', projectId: 'P', configuration });
const serviceWith = (analyzerDevice: unknown, muxDevice: unknown) =>
  new ExperimentConfigService({
    taskPreference: { findFirst: jest.fn(async () => ({ id: 1, name: 'cfg', analyzerDevice, muxDevice, ranges: [] })) },
  } as any, registry);

describe('ExperimentConfigService.resolve', () => {
  it('sensor + selector: plugins, contextos con configuración efectiva y rango del selector', async () => {
    const r = (await serviceWith(device('s', 'sim-impedance', { rp: 40000 }), device('m', 'kronos-mux-16')).resolve(7))!;
    expect(r.sensor.plugin).toBe(registry.get('sim-impedance'));
    expect(r.sensor.context).toEqual({ id: 's', name: 'Dev s', ip: '10.0.0.1', configuration: { rs: 150, rp: 40000, c: 2, noisePercent: 0.5 } });
    expect(r.selector).toMatchObject({ actuatorId: 'kronos-mux-16-channel', valueName: 'channel', context: { id: 'm', configuration: {} } });
    expect(r.selector!.plugin).toBe(registry.get('kronos-mux-16'));
    expect(r.channelRange).toEqual({ min: 1, max: 16 });
    expect(r.valueMetas.map((v) => v.name)).toEqual(['z']);
    expect(r.experiment.fullName).toBe('Simulador (Randles) + MUX Kronos 16');
  });

  it('sin selector: canal 1', async () => {
    const r = (await serviceWith(device('s', 'hioki-im3570'), null).resolve(7))!;
    expect(r.selector).toBeNull();
    expect(r.channelRange).toEqual({ min: 1, max: 1 });
  });

  it('tipos guardados que ya no corresponden a su rol: 400 claro', async () => {
    await expect(serviceWith(device('s', 'analyzer'), null).resolve(7)).rejects.toThrow(
      new BadRequestException('La configuración de la tarea usa "Dev s" (tipo "analyzer"), que no es un equipo de medición registrado; revisa la configuración'),
    );
    await expect(serviceWith(device('s', 'hioki-im3570'), device('m', 'mux')).resolve(7)).rejects.toThrow(
      /usa "Dev m" \(tipo "mux"\), que no es un selector de canal registrado/,
    );
  });
});

describe('ExperimentConfigService.summarize', () => {
  const s = serviceWith(null, null);
  it('rango del selector; selector con rol incorrecto o sensor desconocido no lanzan', () => {
    expect(s.summarize({ analyzerDevice: { type: 'hioki-im3570' }, muxDevice: { type: 'kronos-mux-16' } }))
      .toMatchObject({ channelRange: { min: 1, max: 16 }, simulated: false });
    expect(s.summarize({ analyzerDevice: { type: 'hioki-im3570' }, muxDevice: { type: 'mux' } }).channelRange).toEqual({ min: 1, max: 1 });
    expect(s.summarize({ analyzerDevice: { type: 'analyzer' }, muxDevice: null })).toEqual({
      channelRange: { min: 1, max: 1 }, sensorValues: [], simulated: false, experiment: null,
    });
  });

  it('experimento con nombre por tipos; tipo desconocido → null', () => {
    expect(s.summarize({ analyzerDevice: { type: 'hioki-im3570' }, muxDevice: { type: 'kronos-mux-16' } }).experiment)
      .toEqual({ experimentId: 'hioki-im3570+kronos-mux-16', fullName: 'Hioki IM3570 + MUX Kronos 16' });
    expect(s.summarize({ analyzerDevice: { type: 'hioki-im3570' }, muxDevice: null }).experiment)
      .toEqual({ experimentId: 'hioki-im3570', fullName: 'Hioki IM3570' });
    expect(s.summarize({ analyzerDevice: { type: 'hioki-im3570' }, muxDevice: { type: 'mux' } }).experiment).toBeNull();
  });
});
