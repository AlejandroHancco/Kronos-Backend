import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/database';
import { NotificationWriter } from './notification.writer';

// RealtimeModule is @Global in the host app, so RealtimePublisher resolves without importing it here.
@Module({
  imports: [PrismaModule],
  providers: [NotificationWriter],
  exports: [NotificationWriter],
})
export class NotificationsModule {}
