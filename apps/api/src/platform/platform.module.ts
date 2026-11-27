import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '@app/database';
import { MailModule } from '../mail/mail.module';
import { TeamsModule } from '../teams/teams.module';
import { PlatformController } from './platform.controller';
import { PlatformService } from './platform.service';
import { PlatformAdminGuard } from './platform-admin.guard';

@Module({
  imports: [PrismaModule, ConfigModule, MailModule, TeamsModule],
  controllers: [PlatformController],
  providers: [PlatformService, PlatformAdminGuard],
})
export class PlatformModule {}
