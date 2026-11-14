import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

/** Worker (placeholder): se completa en tareas posteriores. */
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
})
export class WorkerModule {}
