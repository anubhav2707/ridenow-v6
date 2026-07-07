import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { CoreModule } from './core/core.module';
import { DriverModule } from './drivers/driver.module';
import { GpsModule } from './gps/gps.module';
import { HealthModule } from './health/health.module';
import { PaymentsModule } from './payments/payments.module';
import { QuoteModule } from './quotes/quote.module';
import { RideModule } from './rides/ride.module';

@Module({
  imports: [
    CoreModule,
    HealthModule,
    AuthModule,
    QuoteModule,
    RideModule,
    DriverModule,
    GpsModule,
    PaymentsModule,
  ],
})
export class AppModule {}