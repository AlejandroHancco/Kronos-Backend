import * as dotenv from 'dotenv';
dotenv.config();  // carga ANTES de todo

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { RedisIoAdapter } from './realtime/redis-io.adapter';

async function bootstrap() {
    const app = await NestFactory.create(AppModule);
    app.enableCors({ exposedHeaders: ['Content-Disposition'] });
    app.useGlobalPipes(
        new ValidationPipe({
            whitelist: true,
            forbidNonWhitelisted: true,
            transform: true,
        }),
    );
    app.useWebSocketAdapter(new RedisIoAdapter(app));
    await app.listen(3000);
    console.log('App corriendo en puerto 3000');
}
void bootstrap();