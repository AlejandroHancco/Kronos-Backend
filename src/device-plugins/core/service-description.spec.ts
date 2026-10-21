import { parseServiceDescription } from './service-description';

const valid = () => ({
  deviceType: 'demo-sensor', fullName: 'Demo', shortName: 'Demo', manufacturer: 'K', description: 'd',
  simulated: true, connection: { requiresIp: false },
  sensors: [{ sensorId: 's', fullName: 'S', description: '', protocol: 'simulated', produces: 'application/json',
    sensorValues: [{ name: 'z', unit: 'Ω', type: 'double' }], accessMode: { accessModeType: 'pull' } }],
  actuators: [],
  configuration: [{ name: 'rs', label: 'Rs', type: 'double', unit: 'Ω', rangeMinimum: 0, rangeMaximum: 10, default: 1, access: 'read-write', storage: 'persisted' }],
});

describe('parseServiceDescription', () => {
  it('acepta una descripción válida y la congela', () => {
    const d = parseServiceDescription(valid(), 'demo');
    expect(d.deviceType).toBe('demo-sensor');
    expect(Object.isFrozen(d.sensors[0].sensorValues[0])).toBe(true);
  });
  it.each([
    [(d: any) => { d.deviceType = 'Demo Sensor'; }, /deviceType/],
    [(d: any) => { d.deviceType = 'x'.repeat(51); }, /deviceType/],
    [(d: any) => { delete d.shortName; }, /shortName/],
    [(d: any) => { d.sensors[0].protocol = 'udp'; }, /protocol/],
    [(d: any) => { d.sensors[0].sensorValues.push({ name: 'z', unit: 'Ω', type: 'double' }); }, /repetido "z"/],
    [(d: any) => { d.sensors[0].sensorValues[0].name = 'Z-1'; }, /sensorValues/],
    [(d: any) => { d.channelSelector = { actuatorId: 'nope', valueName: 'channel' }; }, /channelSelector/],
    [(d: any) => { d.configuration[0].default = 99; }, /rs/],
    [(d: any) => { delete d.configuration[0].default; }, /default/],
    [(d: any) => { d.configuration[0].storage = 'fixed'; }, /solo lectura|read-only/],
    [(d: any) => { d.configuration[0].storage = 'cache'; }, /storage/],
  ])('rechaza descripciones inválidas (%#)', (mutate, msg) => {
    const d = valid(); mutate(d);
    expect(() => parseServiceDescription(d, 'demo')).toThrow(msg);
    expect(() => parseServiceDescription(d, 'demo')).toThrow(/service-description\.json de "demo"/);
  });
  it('channelSelector debe apuntar a un valor entero con rango ≥ 1', () => {
    const d: any = valid();
    d.sensors = [];
    d.actuators = [{ actuatorId: 'sel', fullName: 'Sel', description: '', protocol: 'http', inputType: 'integer',
      actuatorValues: [{ name: 'channel', unit: '', type: 'double', rangeMinimum: 1, rangeMaximum: 16 }], accessMode: { accessModeType: 'pull' } }];
    d.channelSelector = { actuatorId: 'sel', valueName: 'channel' };
    expect(() => parseServiceDescription(d, 'demo')).toThrow(/entero/);
  });
  it('rechaza configuration con nombres de parámetros duplicados', () => {
    const d: any = valid();
    d.configuration = [
      { name: 'param1', label: 'P1', type: 'double', unit: 'Ω', default: 1, access: 'read-write', storage: 'persisted' },
      { name: 'param1', label: 'P1b', type: 'string', unit: '', default: 'x', access: 'read-write', storage: 'persisted' }
    ];
    expect(() => parseServiceDescription(d, 'demo')).toThrow(/configuration\[1\]\.name.*nombre de parámetro repetido "param1"/);
    expect(() => parseServiceDescription(d, 'demo')).toThrow(/service-description\.json de "demo"/);
  });
  it('rechaza configuration con allowedValues de tipo inválido', () => {
    const d: any = valid();
    d.configuration = [
      { name: 'param', label: 'P', type: 'double', unit: 'Ω', allowedValues: [1, 2, {}], default: 1, access: 'read-write', storage: 'persisted' }
    ];
    expect(() => parseServiceDescription(d, 'demo')).toThrow(/configuration\[0\]\.allowedValues\[2\]/);
    expect(() => parseServiceDescription(d, 'demo')).toThrow(/service-description\.json de "demo"/);
  });
  it('rechaza configuration con allowedValues NaN o Infinity', () => {
    const d: any = valid();
    d.configuration = [
      { name: 'param', label: 'P', type: 'double', unit: 'Ω', allowedValues: [1, NaN], default: 1, access: 'read-write', storage: 'persisted' }
    ];
    expect(() => parseServiceDescription(d, 'demo')).toThrow(/configuration\[0\]\.allowedValues\[1\]/);
  });
});
