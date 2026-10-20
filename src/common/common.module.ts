import { Global, Module } from '@nestjs/common';
import { TeamScopeService } from './team-scope.service';
import { SessionEventsService } from './session-events.service';
import { PrismaModule } from '../prisma/prisma.module';

@Global()
@Module({
  imports: [PrismaModule],
  providers: [TeamScopeService, SessionEventsService],
  exports: [TeamScopeService, SessionEventsService],
})
export class CommonModule {}
