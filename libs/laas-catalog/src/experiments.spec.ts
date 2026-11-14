import { LaasCatalog } from './laas-catalog';
import { HIOKI_IM3570, KRONOS_MUX_16, SIM_IMPEDANCE } from './models';
import { experimentCatalog, experimentFor, experimentIdOf } from './experiments';

const entries = new LaasCatalog([HIOKI_IM3570, KRONOS_MUX_16, SIM_IMPEDANCE]).catalog();

describe('experimentos derivados', () => {
  it('deriva sensor × (selector | nada), combinaciones primero', () => {
    expect(experimentCatalog(entries).map((e) => [e.experimentId, e.fullName, e.channelRange.max])).toEqual([
      ['hioki-im3570+kronos-mux-16', 'Hioki IM3570 + MUX Kronos 16', 16],
      ['hioki-im3570', 'Hioki IM3570', 1],
      ['sim-impedance+kronos-mux-16', 'Simulador (Randles) + MUX Kronos 16', 16],
      ['sim-impedance', 'Simulador (Randles)', 1],
    ]);
  });

  it('descripciones según haya selector o no', () => {
    const [withMux, alone] = experimentCatalog(entries);
    expect(withMux.description).toBe('Hioki IM3570 mide hasta 16 canales a través de MUX Kronos 16');
    expect(alone.description).toBe('Hioki IM3570 mide un único canal (conexión directa, canal 1)');
  });

  it('experimentFor resuelve por tipos y null si no es combinación válida', () => {
    expect(experimentFor(entries, 'sim-impedance', null)).toMatchObject({ simulated: true, sensorValues: [{ name: 'z', unit: 'Ω' }] });
    expect(experimentFor(entries, 'kronos-mux-16', null)).toBeNull();
    expect(experimentFor(entries, 'hioki-im3570', 'sim-impedance')).toBeNull();
    expect(experimentFor(entries, 'analyzer', null)).toBeNull();
    expect(experimentIdOf('hioki-im3570', null)).toBe('hioki-im3570');
  });

  it('cada definición declara la misma adquisición que su sensor', () => {
    const sensorAcquisitions = new Map(entries.filter((e) => e.role === 'sensor').map((e) => [e.deviceType, e.acquisition!.kind]));
    for (const def of experimentCatalog(entries)) {
      expect(def.acquisition.kind).toBe(sensorAcquisitions.get(def.sensorType));
    }
  });
});
