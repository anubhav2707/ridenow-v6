import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import {
  AuthService,
  type AuthSession,
  type AuthTokens,
  type OtpRequestResult,
} from './auth.service';

interface OtpRequestBody {
  phone: string;
}

interface OtpVerifyBody {
  phone: string;
  code: string;
}

interface RefreshBody {
  refreshToken: string;
}

/**
 * Passwordless rider auth. No endpoint here ever accepts or returns a password;
 * the only credentials are an SMS code (to sign in) and the rotating refresh
 * token (to stay signed in).
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // Step 1: send a one-time code. 200 (not 201) — nothing is created that the
  // client can address, and the raw code is never returned.
  @Post('otp/request')
  @HttpCode(200)
  requestOtp(@Body() body: OtpRequestBody): Promise<OtpRequestResult> {
    return this.auth.requestOtp(body?.phone);
  }

  // Step 2: exchange the code for tokens (creating the account on first login).
  @Post('otp/verify')
  @HttpCode(200)
  verifyOtp(@Body() body: OtpVerifyBody): Promise<AuthSession> {
    return this.auth.verifyOtp(body?.phone, body?.code);
  }

  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() body: RefreshBody): Promise<AuthTokens> {
    return this.auth.refresh(body?.refreshToken);
  }

  @Post('logout')
  @HttpCode(200)
  logout(@Body() body: RefreshBody): Promise<{ revoked: boolean }> {
    return this.auth.logout(body?.refreshToken);
  }
}
