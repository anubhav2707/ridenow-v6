import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import {
  CurrentUser,
  type RequestUser,
} from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import {
  PaymentMethodService,
  type PaymentMethodView,
  type SavePaymentMethodInput,
} from './payment-method.service';

/**
 * Saved rider cards. Every route is protected by JwtAuthGuard + RolesGuard, so
 * the rider is identified from the access token (not a body field) and cards are
 * always scoped to that authenticated account.
 */
@Controller('payment-methods')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('rider')
export class PaymentMethodController {
  constructor(private readonly paymentMethods: PaymentMethodService) {}

  @Post()
  save(
    @CurrentUser() user: RequestUser,
    @Body() body: SavePaymentMethodInput,
  ): Promise<PaymentMethodView> {
    return this.paymentMethods.save(user.userId, body);
  }

  @Get()
  list(@CurrentUser() user: RequestUser): Promise<PaymentMethodView[]> {
    return this.paymentMethods.list(user.userId);
  }
}
