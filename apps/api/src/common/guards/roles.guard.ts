import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserRole } from '../../auth/auth.repository';
import { ROLES_KEY } from '../decorators/roles.decorator';
import type { AuthedRequest } from '../decorators/current-user.decorator';

/**
 * Enforces the @Roles(...) claim on a route (rider/driver separation). Runs after
 * JwtAuthGuard, which has already attached req.user. A route with no @Roles is
 * allowed for any authenticated user.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (!req.user) throw new UnauthorizedException('authentication required');
    if (!required.includes(req.user.role)) {
      throw new ForbiddenException(
        `this action requires one of: ${required.join(', ')}`,
      );
    }
    return true;
  }
}
