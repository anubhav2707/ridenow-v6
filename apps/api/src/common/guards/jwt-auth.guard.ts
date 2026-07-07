import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { TokenService } from '../../auth/token.service';
import type { AuthedRequest } from '../decorators/current-user.decorator';

/**
 * Verifies the Bearer access-token signature via TokenService and attaches
 * req.user = {userId, role}. Any missing/malformed/expired/invalid token is a
 * 401 — the token itself is the whole credential (there is no password).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly tokens: TokenService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('missing bearer token');
    }
    const token = header.slice('Bearer '.length).trim();
    // verifyAccess throws UnauthorizedException on bad signature / expiry / type.
    const claims = this.tokens.verifyAccess(token);
    req.user = { userId: claims.sub, role: claims.role };
    return true;
  }
}
