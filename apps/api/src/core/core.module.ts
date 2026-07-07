import { Global, Module } from '@nestjs/common';
import { CLOCK, SystemClock } from '../clock/clock';
import { ENV, loadEnv, type Env } from '../config/env';
import { EarningsService } from '../earnings/earnings.service';
import { FareService } from '../fares/fare.service';
import { LedgerService } from '../ledger/ledger.service';
import { FakePaymentGateway } from '../payments/fake-payment-gateway';
import {
  PAYMENT_GATEWAY,
  type PaymentGateway,
} from '../payments/payment-gateway';
import { StripePaymentGateway } from '../payments/stripe-payment-gateway';
import { DrizzleRideRepository } from '../persistence/drizzle.repository';
import { InMemoryRideRepository } from '../persistence/in-memory.repository';
import {
  RIDE_REPOSITORY,
  type RideRepository,
} from '../persistence/repository';
import { HaversineRouting, ROUTING } from '../routing/routing';

/**
 * Global wiring for the domain ports. Everything that varies by environment
 * (which gateway, which store) is chosen here from the validated Env so the
 * feature services just inject stable tokens.
 */
@Global()
@Module({
  providers: [
    { provide: ENV, useFactory: (): Env => loadEnv() },
    { provide: CLOCK, useClass: SystemClock },
    { provide: ROUTING, useClass: HaversineRouting },
    {
      provide: PAYMENT_GATEWAY,
      useFactory: (env: Env): PaymentGateway =>
        env.paymentsDriver === 'stripe'
          ? new StripePaymentGateway(env.stripeSecretKey ?? '')
          : new FakePaymentGateway(),
      inject: [ENV],
    },
    {
      provide: RIDE_REPOSITORY,
      useFactory: (env: Env): RideRepository =>
        env.store === 'postgres'
          ? new DrizzleRideRepository()
          : new InMemoryRideRepository(),
      inject: [ENV],
    },
    FareService,
    LedgerService,
    EarningsService,
  ],
  exports: [
    ENV,
    CLOCK,
    ROUTING,
    PAYMENT_GATEWAY,
    RIDE_REPOSITORY,
    FareService,
    LedgerService,
    EarningsService,
  ],
})
export class CoreModule {}
