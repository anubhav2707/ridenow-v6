import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SmsService } from './sms.service';
import { TokenService } from './token.service';

/**
 * Passwordless-auth wiring. AUTH_REPOSITORY, CLOCK and ENV come from the global
 * CoreModule. TokenService + the guards are exported so other feature modules
 * (e.g. saved payment methods) can protect their routes with the same identity.
 */
@Module({
  controllers: [AuthController],
  providers: [AuthService, TokenService, SmsService, JwtAuthGuard, RolesGuard],
  exports: [AuthService, TokenService, JwtAuthGuard, RolesGuard],
})
export class AuthModule {}
