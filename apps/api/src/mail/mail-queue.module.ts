import { Module } from '@nestjs/common';
import { QueueModule } from '@app/queue';
import { MailModule } from './mail.module';
import { MailQueueProcessor } from './mail-queue.processor';

/** Solo en la API: consume la cola 'mail' (el worker publica ahí con MailOutbox). */
@Module({
  imports: [QueueModule, MailModule],
  providers: [MailQueueProcessor],
})
export class MailQueueModule {}
