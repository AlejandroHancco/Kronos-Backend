import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/database';
import { TeamsController } from './teams.controller';
import { TeamsService } from './teams.service';
import { TeamAdminService } from './team-admin.service';

@Module({
  imports: [PrismaModule],
  controllers: [TeamsController],
  providers: [TeamsService, TeamAdminService],
  exports: [TeamsService, TeamAdminService],
})
export class TeamsModule {}

