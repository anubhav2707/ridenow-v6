import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '../../auth/auth.repository';

export const ROLES_KEY = 'ridenow:roles';

/**
 * @Roles('rider') — restrict a route to the given role claim(s). Enforced by
 * RolesGuard, which pairs with JwtAuthGuard (rider/driver separation).
 */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
