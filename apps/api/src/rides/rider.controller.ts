import { Controller, Get, Param, Query } from '@nestjs/common';
import { RideService, type RepeatStatus } from './ride.service';

// Rider-side repeat-liquidity signal — the actual kill metric for this MVP.
@Controller('riders')
export class RiderController {
  constructor(private readonly rides: RideService) {}

  @Get(':riderPhone/repeat-status')
  repeatStatus(
    @Param('riderPhone') riderPhone: string,
    @Query('region') region: string,
  ): Promise<RepeatStatus> {
    return this.rides.riderRepeatStatus(riderPhone, region);
  }
}
