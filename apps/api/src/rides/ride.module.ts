import { Module } from '@nestjs/common';
import { RideController } from './ride.controller';
import { RideService } from './ride.service';
import { RiderController } from './rider.controller';

@Module({
  controllers: [RideController, RiderController],
  providers: [RideService],
  exports: [RideService],
})
export class RideModule {}
