import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  const app = await NestFactory.create(WorkerModule);
  app.enableShutdownHooks();

  const port = Number(process.env.HEALTH_PORT ?? 3001);
  await app.listen(port);
  Logger.log(`Worker health endpoint on port ${port}`, 'Bootstrap');
}

void bootstrap();
