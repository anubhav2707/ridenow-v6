import { Module } from '@nestjs/common';
import { GpsController } from './gps.controller';
import { GpsService } from './gps.service';

// RIDE_REPOSITORY and CLOCK come from the global CoreModule.
@Module({
  controllers: [GpsController],
  providers: [GpsService],
  exports: [GpsService],
})
export class GpsModule {}
