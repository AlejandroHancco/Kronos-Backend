import * as dotenv from 'dotenv';
dotenv.config();  // carga ANTES de todo

import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { RedisIoAdapter } from './realtime/redis-io.adapter';

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
void bootstrap();
