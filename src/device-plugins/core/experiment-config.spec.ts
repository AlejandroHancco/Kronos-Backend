import { HiokiIm3570Plugin } from '../plugins/hioki-im3570/hioki-im3570.plugin';
import { SimulatedImpedancePlugin } from '../plugins/sim-impedance/sim-impedance.plugin';
import { channelRangeFor, channelSelectionError, experimentConfigError, invalidChannels, channelRangeMessage, valueMetasOf } from './experiment-config';

const hioki = new HiokiIm3570Plugin().describe();
const sim = new SimulatedImpedancePlugin().describe();
const dev = (type: string, projectId = 'P', name = type) => ({ id: `${type}-id`, name, type, projectId });
const base = { taskProjectId: 'P', sensorRole: 'sensor' as const };

describe('experimentConfigError', () => {
  it('Hioki + MUX del proyecto: válido', () => {
    expect(experimentConfigError({ ...base, sensor: dev('analyzer'), mux: dev('mux'), description: hioki })).toBeNull();
  });
  it('simulado sin MUX: válido', () => {
    expect(experimentConfigError({ ...base, sensor: dev('sim-impedance'), mux: null, description: sim })).toBeNull();
  });
  it('Hioki sin MUX: requiere MUX', () => {
    expect(experimentConfigError({ ...base, sensor: dev('analyzer'), mux: null, description: hioki })).toMatch(/requiere un MUX de canales/);
  });
  it('simulado con MUX: no admite MUX', () => {
    expect(experimentConfigError({ ...base, sensor: dev('sim-impedance'), mux: dev('mux'), description: sim })).toMatch(/no admite MUX/);
  });
  it('MUX de tipo incorrecto o de otro proyecto', () => {
    expect(experimentConfigError({ ...base, sensor: dev('analyzer'), mux: dev('analyzer'), description: hioki })).toMatch(/tipo "mux"/);
    expect(experimentConfigError({ ...base, sensor: dev('analyzer'), mux: dev('mux', 'Q'), description: hioki })).toMatch(/MUX no pertenece/);
  });
  it('equipo de medición de otro proyecto o que no es sensor', () => {
    expect(experimentConfigError({ ...base, sensor: dev('analyzer', 'Q'), mux: dev('mux'), description: hioki })).toMatch(/no pertenece al proyecto/);
    expect(experimentConfigError({ ...base, sensorRole: 'channel-selector', sensor: dev('mux'), mux: null, description: hioki })).toMatch(/no es un equipo de medición/);
    expect(experimentConfigError({ ...base, sensorRole: undefined, sensor: dev('raro'), mux: null, description: undefined })).toMatch(/no es un equipo de medición/);
  });
});

describe('channelRangeFor / invalidChannels', () => {
  it('con MUX usa el rango del actuator; sin MUX solo canal 1', () => {
    expect(channelRangeFor(hioki, true)).toEqual({ min: 1, max: 16 });
    expect(channelRangeFor(sim, false)).toEqual({ min: 1, max: 1 });
  });
  it('detecta canales fuera de rango con mensaje claro', () => {
    expect(invalidChannels([1, 2], { min: 1, max: 1 })).toEqual([2]);
    expect(channelRangeMessage({ min: 1, max: 1 }, [2])).toBe('Sin MUX solo se mide el canal 1');
    expect(channelRangeMessage({ min: 1, max: 16 }, [17])).toBe('Canales fuera de rango para esta configuración (permitidos: 1–16): 17');
  });
});

it('valueMetasOf aplana los sensorValues declarados', () => {
  expect(valueMetasOf(hioki)).toEqual([{ name: 'g', unit: 'S', label: 'Conductancia' }, { name: 'b', unit: 'S', label: 'Susceptancia' }]);
  expect(valueMetasOf(sim)).toEqual([{ name: 'z', unit: 'Ω', label: 'Módulo de impedancia |Z|' }]);
});

describe('channelSelectionError', () => {
  const selector = { selectChannel: async () => undefined };
  it('sin MUX: nunca hay error', () => {
    expect(channelSelectionError(false, sim, {})).toBeNull();
  });
  it('con MUX y plugin que declara y admite selección de canal: válido', () => {
    expect(channelSelectionError(true, hioki, selector)).toBeNull();
  });
  it('con MUX pero sin channelSelection declarado o sin selectChannel: error claro', () => {
    expect(channelSelectionError(true, sim, selector)).toMatch(/tiene un MUX pero el equipo no admite selección de canal/);
    expect(channelSelectionError(true, hioki, {})).toMatch(/tiene un MUX pero el equipo no admite selección de canal/);
  });
});
