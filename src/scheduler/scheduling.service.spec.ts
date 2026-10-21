import { MeasurementSchedulingService } from './scheduling.service';

const hiokiAcq = {
  kind: 'sweep' as const,
  variable: { name: 'frequency', unit: 'Hz', label: 'Frecuencia', rangeMinimum: 4, rangeMaximum: 5000000 },
  points: { minimum: 1, maximum: 801 },
  scales: ['LIN', 'LOG'] as const,
  secondsPerPoint: 0.01,
};

function setup() {
  const prisma = {};
  const measurementsService = {};
  const kronosGateway = {};
  const experimentConfig = {};
  return new MeasurementSchedulingService(prisma as any, measurementsService as any, kronosGateway as any, experimentConfig as any);
}

describe('MeasurementSchedulingService.estimateSeconds (desde la adquisición del dispositivo de medición)', () => {
  it('con selector: canales × (cambio de canal + Σ rangos(setup + puntos·t))', () => {
    const service = setup();
    expect(service.estimateSeconds(hiokiAcq as any, [{ points: 801 }], 2, true)).toBe(Math.ceil(2 * (1.5 + 1 + 8.01)));
  });

  it('sin selector, 1 canal: sin el término de cambio de canal', () => {
    const service = setup();
    expect(service.estimateSeconds(hiokiAcq as any, [{ points: 801 }], 1, false)).toBe(Math.ceil(9.01));
  });
});
