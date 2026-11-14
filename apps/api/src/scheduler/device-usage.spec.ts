import { deviceIdsOf, sharesDevice } from './device-usage';

describe('device-usage', () => {
  it('omite el MUX nulo', () => {
    expect(deviceIdsOf({ sensorDeviceId: 'A', channelSelectorDeviceId: null })).toEqual(['A']);
    expect(deviceIdsOf({ sensorDeviceId: 'A', channelSelectorDeviceId: 'M' })).toEqual(['A', 'M']);
  });
  it('dos tareas sin MUX con analizadores distintos NO chocan (antes null === null)', () => {
    expect(sharesDevice({ sensorDeviceId: 'A', channelSelectorDeviceId: null }, { sensorDeviceId: 'B', channelSelectorDeviceId: null })).toBe(false);
  });
  it('chocan si comparten analizador o MUX', () => {
    expect(sharesDevice({ sensorDeviceId: 'A', channelSelectorDeviceId: null }, { sensorDeviceId: 'A', channelSelectorDeviceId: 'M' })).toBe(true);
    expect(sharesDevice({ sensorDeviceId: 'A', channelSelectorDeviceId: 'M' }, { sensorDeviceId: 'B', channelSelectorDeviceId: 'M' })).toBe(true);
  });
});
