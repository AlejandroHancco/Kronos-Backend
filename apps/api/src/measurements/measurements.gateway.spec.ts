import { MeasurementsGateway } from './measurements.gateway';

describe('MeasurementsGateway.emitMeasurementCompleted', () => {
  it('incluye channels (canales medidos) en el evento measurement:completed', () => {
    const wsAuth = {} as any;
    const sessionEvents = { onUserSessionsRevoked: jest.fn() } as any;
    const gateway = new MeasurementsGateway(wsAuth, sessionEvents);
    const emit = jest.fn();
    (gateway as any).server = { to: jest.fn(() => ({ emit })) };

    const takenAt = new Date();
    gateway.emitMeasurementCompleted(
      'u1', 'job1', 42, takenAt, 1,
      [{ values: { z: [1] } }],
      [{ name: 'z', unit: 'Ω' }],
      { kind: 'single' },
      [1, 3],
    );

    expect(emit).toHaveBeenCalledWith('measurement:completed', expect.objectContaining({ channels: [1, 3] }));
  });
});
