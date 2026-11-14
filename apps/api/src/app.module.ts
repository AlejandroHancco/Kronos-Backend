import { Module, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { SchedulerModule } from './scheduler/scheduler.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ProjectsModule } from './projects/projects.module';
import { TeamsModule } from './teams/teams.module';
import { TasksModule } from './tasks/tasks.module';
import { MeasurementsModule } from './measurements/measurements.module';
import { DevicesModule } from './devices/devices.module';
import { TaskChannelsModule } from './task-channels/task-channels.module';
import { MeasurementChannelsModule } from './measurement-channels/measurement-channels.module';
import { ScheduledJobsModule } from './scheduled-jobs/scheduled-jobs.module';
import { PermissionsModule } from './permissions/permissions.module';
import { NotificationsModule } from './notifications/notifications.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { HealthModule } from './health/health.module';
import { SearchModule } from './search/search.module';
import { ReportsModule } from './reports/reports.module';
import { DevicePluginsModule } from '@app/device-plugins';
import { GatewayModule } from './gateway/gateway.module';
import { RedisModule } from '@app/redis';
import { RealtimeModule } from '@app/realtime';
import { CommonModule } from '@app/common';
import { PrismaService, PrismaModule } from '@app/database';
import { RlsMiddleware } from './prisma/prisma.middleware';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    // Rate limiting global: 100 requests por minuto por IP
    ThrottlerModule.forRoot([
      {
        ttl: 60000,
        limit: 100,
      },
    ]),
    PrismaModule,
    CommonModule,
    DevicePluginsModule,
    RedisModule,
    RealtimeModule,
    GatewayModule,
    AuthModule,
    UsersModule,
    ProjectsModule,
    TeamsModule,
    TasksModule,
    MeasurementsModule,
    DevicesModule,
    TaskChannelsModule,
    MeasurementChannelsModule,
    ScheduledJobsModule,
    // Orquestación de mediciones: cron de ScheduledJobs + control de admisión
    SchedulerModule,
    PermissionsModule,
    NotificationsModule,
    ReportsModule,
    DashboardModule,
    HealthModule,
    SearchModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    PrismaService,
    // Aplica el rate limit a toda la API
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RlsMiddleware).forRoutes('*');
  }
}
