import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';
import { DriverParityCheck } from './driver-parity.check';

// Respaldo: un rechazo no manejado (p. ej. un corte de Redis en una librería)
// se registra en lugar de tumbar el proceso (Node >= 15 sale por defecto).
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  Logger.error(`Unhandled promise rejection: ${err.message}`, err.stack, 'Process');
});

async function bootstrap() {
  const app = await NestFactory.create(WorkerModule);
  // Antes de cualquier listen/consumo de jobs: un modelo del catálogo sin driver aborta el arranque.
  app.get(DriverParityCheck).run();
  app.enableShutdownHooks();

  const port = Number(process.env.HEALTH_PORT ?? 3001);
  await app.listen(port);
  Logger.log(`Worker health endpoint on port ${port}`, 'Bootstrap');
}

// El arranque fallido (p. ej. REDIS_URL ausente) debe seguir terminando el proceso.
bootstrap().catch((err: unknown) => {
  const e = err instanceof Error ? err : new Error(String(err));
  Logger.error(`Bootstrap failed: ${e.message}`, e.stack, 'Bootstrap');
  process.exit(1);
});
