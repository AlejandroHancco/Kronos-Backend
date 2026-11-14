import * as dotenv from 'dotenv';
dotenv.config();  // carga ANTES de todo

import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { RedisIoAdapter } from './realtime/redis-io.adapter';

// Respaldo: un rechazo no manejado (p. ej. un corte de Redis en una librería)
// se registra en lugar de tumbar el proceso (Node >= 15 sale por defecto).
process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    Logger.error(`Unhandled promise rejection: ${err.message}`, err.stack, 'Process');
});

async function bootstrap() {
    const app = await NestFactory.create<NestExpressApplication>(AppModule);
    // Detrás de un proxy inverso (nginx): IP real para el rate limit
    app.set('trust proxy', 1);
    app.enableCors({
        origin: process.env.FRONTEND_URL ?? 'http://localhost:5173',
        credentials: true,
        exposedHeaders: ['Content-Disposition'],
    });
    app.useGlobalPipes(
        new ValidationPipe({
            whitelist: true,
            forbidNonWhitelisted: true,
            transform: true,
        }),
    );
    app.useWebSocketAdapter(new RedisIoAdapter(app));
    app.enableShutdownHooks();
    const port = Number(process.env.PORT ?? 3000);
    await app.listen(port);
    Logger.log(`App corriendo en puerto ${port}`, 'Bootstrap');
}
// El arranque fallido (p. ej. REDIS_URL ausente) debe seguir terminando el proceso.
bootstrap().catch((err: unknown) => {
    const e = err instanceof Error ? err : new Error(String(err));
    Logger.error(`Bootstrap failed: ${e.message}`, e.stack, 'Bootstrap');
    process.exit(1);
});
