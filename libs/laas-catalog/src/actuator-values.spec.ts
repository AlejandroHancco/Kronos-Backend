import type { ActuatorMetadata } from './contract';
import { actuatorMissingMessage, actuatorValuesError, isActuatorValueError } from './actuator-values';

const actuator = (value: Partial<ActuatorMetadata['actuatorValues'][number]>): ActuatorMetadata => ({
  actuatorId: 'mux-channel',
  fullName: 'Selector',
  description: '',
  protocol: 'http',
  inputType: 'integer',
  actuatorValues: [{ name: 'channel', unit: '', type: 'integer', ...value }],
  accessMode: { accessModeType: 'pull' },
});

describe('actuatorValuesError (IEEE 1876 §4.4.1)', () => {
  const mux = actuator({ rangeMinimum: 1, rangeMaximum: 16, rangeStep: 1 });

  it('acepta valores dentro del rango y en paso', () => {
    expect(actuatorValuesError(mux, { channel: 1 })).toBeNull();
    expect(actuatorValuesError(mux, { channel: 16 })).toBeNull();
  });

  it('rechaza fuera de rango, no numéricos, fuera de paso y valores no declarados', () => {
    expect(actuatorValuesError(mux, { channel: 17 })).toBe('"channel" debe estar entre 1 y 16');
    expect(actuatorValuesError(mux, { channel: 0 })).toBe('"channel" debe estar entre 1 y 16');
    expect(actuatorValuesError(mux, { channel: 'x' })).toBe('"channel" debe estar entre 1 y 16');
    expect(actuatorValuesError(mux, { channel: 2.5 })).toBe('"channel" debe avanzar en pasos de 1 desde 1');
    expect(actuatorValuesError(mux, { foo: 2 })).toBe('"foo" no es un valor del actuator "mux-channel"');
  });

  it('solo comprueba las cotas declaradas', () => {
    expect(actuatorValuesError(actuator({ rangeMinimum: 1 }), { channel: 0 })).toBe('"channel" debe ser ≥ 1');
    expect(actuatorValuesError(actuator({ rangeMaximum: 16 }), { channel: 17 })).toBe('"channel" debe ser ≤ 16');
    expect(actuatorValuesError(actuator({}), { channel: NaN })).toBe('"channel" debe ser un número');
    expect(actuatorValuesError(actuator({ rangeStep: 0.5 }), { channel: 1.25 })).toBe('"channel" debe avanzar en pasos de 0.5');
    expect(actuatorValuesError(actuator({ rangeStep: 0.1, rangeMinimum: 0 }), { channel: 0.3 })).toBeNull();
  });

  it('isActuatorValueError reconoce cada mensaje de validación (y no otros)', () => {
    const messages = [
      actuatorValuesError(mux, { channel: 17 }),
      actuatorValuesError(mux, { channel: 2.5 }),
      actuatorValuesError(mux, { foo: 1 }),
      actuatorValuesError(actuator({ rangeMinimum: 1 }), { channel: 0 }),
      actuatorValuesError(actuator({ rangeMaximum: 1 }), { channel: 2 }),
      actuatorValuesError(actuator({}), { channel: NaN }),
      actuatorMissingMessage('MUX', 'otro'),
    ];
    for (const m of messages) expect(isActuatorValueError(m!)).toBe(true);
    expect(isActuatorValueError('"MUX" está midiendo; espera a que termine para cambiar su configuración')).toBe(false);
    expect(isActuatorValueError('No se pudo activar el canal 4 del MUX')).toBe(false);
  });
});
