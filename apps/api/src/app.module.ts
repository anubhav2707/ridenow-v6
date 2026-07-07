import { Module } from '@nestjs/common';
import { CoreModule } from './core/core.module';
import { DriverModule } from './drivers/driver.module';
import { GpsModule } from './gps/gps.module';
import { HealthModule } from './health/health.module';
import { QuoteModule } from './quotes/quote.module';
import { RideModule } from './rides/ride.module';

@Module({
  imports: [
    CoreModule,
    HealthModule,
    QuoteModule,
    RideModule,
    DriverModule,
    GpsModule,
  ],
})
export class AppModule {}