import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PaymentMethodController } from './payment-method.controller';
import { PaymentMethodService } from './payment-method.service';

/**
 * Rider-facing saved-payment surface. Imports AuthModule so the controller's
 * JwtAuthGuard/RolesGuard (and their TokenService dependency) resolve here.
 * AUTH_REPOSITORY and CLOCK come from the global CoreModule.
 */
@Module({
  imports: [AuthModule],
  controllers: [PaymentMethodController],
  providers: [PaymentMethodService],
  exports: [PaymentMethodService],
})
export class PaymentsModule {}
