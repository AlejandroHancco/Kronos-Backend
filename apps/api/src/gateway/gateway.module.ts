import { Global, Module } from '@nestjs/common';
import { KronosGateway } from './kronos.gateway';
import { AuthModule } from '../auth/auth.module';

@Global()
@Module({
  // AuthModule no depende de los gateways (la revocación va por SessionEventsService): sin ciclo.
  imports: [AuthModule],
  providers: [KronosGateway],
  exports: [KronosGateway],
})
export class GatewayModule {}
