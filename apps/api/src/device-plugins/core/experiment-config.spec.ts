import { HiokiIm3570Plugin } from '../plugins/hioki-im3570/hioki-im3570.plugin';
import { KronosMux16Plugin } from '../plugins/kronos-mux-16/kronos-mux-16.plugin';
import { SimulatedImpedancePlugin } from '../plugins/sim-impedance/sim-impedance.plugin';
import {
  channelRangeFor, channelRangeMessage, channelRangeOf, experimentConfigError, invalidChannels, valueMetasOf,
} from './experiment-config';

const hioki = new HiokiIm3570Plugin().describe();
const mux = new KronosMux16Plugin().describe();
const sim = new SimulatedImpedancePlugin().describe();
const dev = (type: string, projectId = 'P', name = type) => ({ id: `${type}-id`, name, type, projectId });
const sensorOf = (type: string, d = type === 'sim-impedance' ? sim : hioki, projectId = 'P') => ({
  taskProjectId: 'P', sensor: dev(type, projectId), sensorRole: 'sensor' as const, sensorDescription: d,
});

describe('experimentConfigError', () => {
  it('Hioki + MUX del proyecto: válido; Hioki sin MUX: válido', () => {
    expect(experimentConfigError({ ...sensorOf('hioki-im3570'), selector: dev('kronos-mux-16'), selectorRole: 'channel-selector' })).toBeNull();
    expect(experimentConfigError({ ...sensorOf('hioki-im3570'), selector: null })).toBeNull();
  });

  it('simulado + MUX: válido; simulado sin MUX: válido', () => {
    expect(experimentConfigError({ ...sensorOf('sim-impedance'), selector: dev('kronos-mux-16'), selectorRole: 'channel-selector' })).toBeNull();
    expect(experimentConfigError({ ...sensorOf('sim-impedance'), selector: null })).toBeNull();
  });

  it('selector que no es channel-selector', () => {
    expect(experimentConfigError({ ...sensorOf('hioki-im3570'), selector: dev('hioki-im3570', 'P', 'Hioki 2'), selectorRole: 'sensor' }))
      .toBe('El dispositivo "Hioki 2" no es un selector de canal registrado (tipo "hioki-im3570")');
    expect(experimentConfigError({ ...sensorOf('hioki-im3570'), selector: dev('mux'), selectorRole: undefined }))
      .toMatch(/no es un selector de canal registrado/);
  });

  it('selector de otro proyecto', () => {
    expect(experimentConfigError({ ...sensorOf('hioki-im3570'), selector: dev('kronos-mux-16', 'Q'), selectorRole: 'channel-selector' }))
      .toMatch(/El selector de canal no pertenece al proyecto de la tarea/);
  });

  it('equipo de medición de otro proyecto o que no es sensor', () => {
    expect(experimentConfigError({ ...sensorOf('hioki-im3570', hioki, 'Q'), selector: null })).toMatch(/no pertenece al proyecto/);
    expect(experimentConfigError({ taskProjectId: 'P', sensor: dev('kronos-mux-16'), sensorRole: 'channel-selector', selector: null }))
      .toMatch(/no es un equipo de medición/);
    expect(experimentConfigError({ taskProjectId: 'P', sensor: dev('raro'), selector: null })).toMatch(/no es un equipo de medición/);
    expect(experimentConfigError({ taskProjectId: 'P', sensor: { ...dev('x'), type: null }, selector: null }))
      .toBe('El dispositivo "x" no es un equipo de medición registrado (sin tipo)');
  });

  it('sensor sin sensorValues declarados', () => {
    expect(experimentConfigError({ ...sensorOf('x', { ...sim, sensors: [] }), selector: null })).toMatch(/no declara valores de sensor/);
  });
});

describe('channelRangeOf / channelRangeFor / invalidChannels', () => {
  it('rango del selector; sin selector solo canal 1', () => {
    expect(channelRangeOf(mux)).toEqual({ min: 1, max: 16 });
    expect(channelRangeOf(hioki)).toBeNull();
    expect(channelRangeFor(mux)).toEqual({ min: 1, max: 16 });
    expect(channelRangeFor(null)).toEqual({ min: 1, max: 1 });
  });

  it('acota el rango declarado a [1, 16]', () => {
    const wide = {
      ...mux,
      actuators: [{ ...mux.actuators[0], actuatorValues: [{ ...mux.actuators[0].actuatorValues[0], rangeMaximum: 64 }] }],
    };
    expect(channelRangeOf(wide)).toEqual({ min: 1, max: 16 });
  });

  it('detecta canales fuera de rango con mensaje claro', () => {
    expect(invalidChannels([1, 2], { min: 1, max: 1 })).toEqual([2]);
    expect(channelRangeMessage({ min: 1, max: 1 }, [2])).toBe('Sin selector de canal solo se mide el canal 1');
    expect(channelRangeMessage({ min: 1, max: 16 }, [17])).toBe('Canales fuera de rango para esta configuración (permitidos: 1–16): 17');
  });
});

it('valueMetasOf aplana los sensorValues declarados', () => {
  expect(valueMetasOf(hioki)).toEqual([{ name: 'g', unit: 'S', label: 'Conductancia' }, { name: 'b', unit: 'S', label: 'Susceptancia' }]);
  expect(valueMetasOf(sim)).toEqual([{ name: 'z', unit: 'Ω', label: 'Módulo de impedancia |Z|' }]);
  expect(valueMetasOf(mux)).toEqual([]);
});
