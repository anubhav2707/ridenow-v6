import { Module } from '@nestjs/common';
import { RideModule } from '../rides/ride.module';
import { DriverController } from './driver.controller';
import { DriverService } from './driver.service';

@Module({
  // RideModule exports RideService (used for driver repeat-status). EarningsService
  // comes from the global CoreModule.
  imports: [RideModule],
  controllers: [DriverController],
  providers: [DriverService],
  exports: [DriverService],
})
export class DriverModule {}
