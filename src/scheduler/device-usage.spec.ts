import { deviceIdsOf, sharesDevice } from './device-usage';

describe('device-usage', () => {
  it('omite el MUX nulo', () => {
    expect(deviceIdsOf({ analyzerDeviceId: 'A', muxDeviceId: null })).toEqual(['A']);
    expect(deviceIdsOf({ analyzerDeviceId: 'A', muxDeviceId: 'M' })).toEqual(['A', 'M']);
  });
  it('dos tareas sin MUX con analizadores distintos NO chocan (antes null === null)', () => {
    expect(sharesDevice({ analyzerDeviceId: 'A', muxDeviceId: null }, { analyzerDeviceId: 'B', muxDeviceId: null })).toBe(false);
  });
  it('chocan si comparten analizador o MUX', () => {
    expect(sharesDevice({ analyzerDeviceId: 'A', muxDeviceId: null }, { analyzerDeviceId: 'A', muxDeviceId: 'M' })).toBe(true);
    expect(sharesDevice({ analyzerDeviceId: 'A', muxDeviceId: 'M' }, { analyzerDeviceId: 'B', muxDeviceId: 'M' })).toBe(true);
  });
});
