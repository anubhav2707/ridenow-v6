import {
  createParamDecorator,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import type { UserRole } from '../../auth/auth.repository';

/** The identity JwtAuthGuard attaches to the request after verifying the token. */
export interface RequestUser {
  userId: string;
  role: UserRole;
}

// Minimal request shape we touch — avoids a hard dependency on @types/express
// (not declared) while still typing the header + attached user precisely.
export interface AuthedRequest {
  headers: { authorization?: string };
  user?: RequestUser;
}

/**
 * @CurrentUser() — returns the authenticated {userId, role} the guard attached.
 * Throws 401 if used on a route that was not protected by JwtAuthGuard.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestUser => {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!req.user) {
      throw new UnauthorizedException('authentication required');
    }
    return req.user;
  },
);
