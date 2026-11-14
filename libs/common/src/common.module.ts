import { Global, Module } from '@nestjs/common';
import { TeamScopeService } from './team-scope.service';
import { PrismaModule } from '@app/database';

@Global()
@Module({
  imports: [PrismaModule],
  providers: [TeamScopeService],
  exports: [TeamScopeService],
})
export class CommonModule {}
