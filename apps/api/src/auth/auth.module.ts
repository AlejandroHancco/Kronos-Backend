import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './jwt.strategy';
import { SupabaseStrategy } from './supabase.strategy';
import { CombinedAuthGuard } from './combined-auth.guard';
import { WsAuthService } from './ws-auth.service';
import { PrismaModule } from '@app/database';
import { MailModule } from '../mail/mail.module';
import { EmailVerificationService } from './email-verification.service';

@Module({
  imports: [
    ConfigModule,
    PassportModule,
    PrismaModule,
    MailModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: '60m' },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, EmailVerificationService, JwtStrategy, SupabaseStrategy, CombinedAuthGuard, WsAuthService],
  exports: [AuthService, CombinedAuthGuard, WsAuthService],
})
export class AuthModule {}
