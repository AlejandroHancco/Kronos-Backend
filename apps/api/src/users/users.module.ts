import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { PrismaModule } from '@app/database';

@Module({
  imports: [PrismaModule],
  controllers: [UsersController],
})
export class UsersModule {}
