import { BadRequestException } from '@nestjs/common';
import { MeasurementSchedulingService } from './scheduling.service';

const hiokiAcq = {
  kind: 'sweep' as const,
  variable: { name: 'frequency', unit: 'Hz', label: 'Frecuencia', rangeMinimum: 4, rangeMaximum: 5000000 },
  points: { minimum: 1, maximum: 801 },
  scales: ['LIN', 'LOG'] as const,
  secondsPerPoint: 0.01,
};

function setup(opts: { resolved?: any; resolveError?: unknown } = {}) {
  const prisma = {
    taskPreference: { findFirst: jest.fn(async () => null) },
  };
  const measurementsService = {};
  const kronosGateway = {};
  const experimentConfig = {
    resolve: jest.fn(async () => {
      if (opts.resolveError) throw opts.resolveError;
      return opts.resolved ?? null;
    }),
  };
  const measurementQueue = { add: jest.fn(), getJobs: jest.fn(async () => []) };
  const service = new MeasurementSchedulingService(
    prisma as any,
    measurementsService as any,
    kronosGateway as any,
    experimentConfig as any,
    measurementQueue as any,
  );
  return { service, prisma, experimentConfig, measurementQueue };
}

describe('MeasurementSchedulingService.estimateSeconds (desde la adquisición del dispositivo de medición)', () => {
  it('con selector: canales × (cambio de canal + Σ rangos(setup + puntos·t))', () => {
    const { service } = setup();
    expect(service.estimateSeconds(hiokiAcq as any, [{ points: 801 }], 2, true)).toBe(Math.ceil(2 * (1.5 + 1 + 8.01)));
  });

  it('sin selector, 1 canal: sin el término de cambio de canal', () => {
    const { service } = setup();
    expect(service.estimateSeconds(hiokiAcq as any, [{ points: 801 }], 1, false)).toBe(Math.ceil(9.01));
  });
});

describe('MeasurementSchedulingService.checkAvailability', () => {
  it('sin preferencia (resolve devuelve null): devuelve el resultado no_preference existente, sin encolar', async () => {
    const { service, experimentConfig, measurementQueue } = setup();
    const result = await service.checkAvailability(1, [{ points: 801 }], [1, 2]);
    expect(result).toEqual({
      estimatedSeconds: 0,
      backlogSeconds: 0,
      maxBacklogSeconds: 15 * 60,
      available: false,
      reason: 'no_preference',
      message: 'Esta tarea no tiene un equipo de medición asignado. Configúralo antes de medir.',
    });
    expect(experimentConfig.resolve).toHaveBeenCalledWith(1);
    expect(measurementQueue.add).not.toHaveBeenCalled();
  });

  it('con selector y 2 canales: estimatedSeconds desde la adquisición resuelta, sin backlog ni conflicto', async () => {
    const resolved = { acquisition: hiokiAcq, selector: { actuatorId: 'mux-1' } };
    const { service, measurementQueue } = setup({ resolved });
    const result = await service.checkAvailability(1, [{ points: 801 }], [1, 2]);
    expect(result.estimatedSeconds).toBe(Math.ceil(2 * (1.5 + 1 + 8.01)));
    expect(result.backlogSeconds).toBe(0);
    expect(result.available).toBe(true);
    expect(measurementQueue.add).not.toHaveBeenCalled();
  });

  it('sin selector y 1 canal: sin el término de cambio de canal', async () => {
    const resolved = { acquisition: hiokiAcq, selector: null };
    const { service } = setup({ resolved });
    const result = await service.checkAvailability(1, [{ points: 801 }], [1]);
    expect(result.estimatedSeconds).toBe(Math.ceil(1 + 8.01));
    expect(result.available).toBe(true);
  });

  it('propaga el BadRequestException de resolve (tipo de dispositivo inconsistente)', async () => {
    const { service } = setup({ resolveError: new BadRequestException('tipo de dispositivo inconsistente') });
    await expect(service.checkAvailability(1, [{ points: 801 }], [1])).rejects.toThrow(BadRequestException);
  });
});
