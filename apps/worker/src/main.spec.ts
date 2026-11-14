jest.mock('./worker.module', () => ({ WorkerModule: class WorkerModule {} }));

type FakeApp = { enableShutdownHooks: jest.Mock; listen: jest.Mock };

/**
 * Carga main.ts en un registro de módulos aislado (con NestFactory.create y Logger espiados en ese
 * mismo registro) y espera a que termine la cadena de promesas de bootstrap().
 */
async function runMain(app: FakeApp) {
  let logError!: jest.SpyInstance;
  jest.isolateModules(() => {
    const { NestFactory } = require('@nestjs/core');
    const { Logger } = require('@nestjs/common');
    jest.spyOn(NestFactory, 'create').mockResolvedValue(app);
    logError = jest.spyOn(Logger, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger, 'log').mockImplementation(() => undefined);
    require('./main');
  });
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  return { logError };
}

const fakeApp = (listen: () => Promise<void> = async () => undefined): FakeApp => ({
  enableShutdownHooks: jest.fn(),
  listen: jest.fn(listen),
});

describe('worker main.ts', () => {
  let exit: jest.SpyInstance;
  let listenersBefore: Function[];

  beforeEach(() => {
    listenersBefore = process.listeners('unhandledRejection');
    exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    // Solo los handlers que añadió main.ts.
    for (const l of process.listeners('unhandledRejection')) {
      if (!listenersBefore.includes(l)) process.removeListener('unhandledRejection', l as any);
    }
  });

  it('si la paridad catálogo/drivers falla al iniciar, registra el modelo y sale con código 1', async () => {
    const app = fakeApp(async () => {
      throw new Error('Catálogo LaaS y drivers no coinciden:\nPlugin "kronos-mux-16": tiene descripción en el catálogo pero está sin driver');
    });
    const { logError } = await runMain(app);
    expect(app.enableShutdownHooks).toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('Plugin "kronos-mux-16"'), expect.anything(), 'Bootstrap');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('arranca el health endpoint en HEALTH_PORT (3001 por defecto) sin salir', async () => {
    const original = process.env.HEALTH_PORT;
    delete process.env.HEALTH_PORT;
    try {
      const app = fakeApp();
      await runMain(app);
      expect(app.listen).toHaveBeenCalledWith(3001);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      if (original !== undefined) process.env.HEALTH_PORT = original;
    }
  });

  it('registra los rechazos no manejados en lugar de tumbar el proceso', async () => {
    const { logError } = await runMain(fakeApp());
    process.emit('unhandledRejection', new Error('redis cayó'), Promise.resolve());
    expect(logError).toHaveBeenCalledWith('Unhandled promise rejection: redis cayó', expect.anything(), 'Process');
  });
});
