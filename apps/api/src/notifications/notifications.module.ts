import { Global, Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { PrismaModule } from '@app/database';
import { NotificationsModule as NotificationWriterModule } from '@app/notifications';

@Global()
@Module({
  imports: [PrismaModule, NotificationWriterModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
