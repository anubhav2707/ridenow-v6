import { Body, Controller, Get, Param, Query } from '@nestjs/common';
import { Post } from '@nestjs/common';
import {
  EarningsService,
  type DriverEarningsSummary,
  type TakeHomeLedgerView,
  type TripEarningsView,
} from '../earnings/earnings.service';
import { RideService, type RepeatStatus } from '../rides/ride.service';
import {
  DriverService,
  type DriverView,
  type OnboardDriverInput,
  type RegisterDriverInput,
} from './driver.service';

@Controller('drivers')
export class DriverController {
  constructor(
    private readonly drivers: DriverService,
    private readonly earnings: EarningsService,
    private readonly rides: RideService,
  ) {}

  @Post()
  register(@Body() body: RegisterDriverInput): Promise<DriverView> {
    return this.drivers.register(body);
  }

  // SCRUM-241 lightweight onboarding: name + vehicle + flat-fee plan, activated
  // immediately with no KYC gate.
  @Post('onboarding')
  onboard(@Body() body: OnboardDriverInput): Promise<DriverView> {
    return this.drivers.onboard(body);
  }

  @Get(':id')
  getOne(@Param('id') id: string): Promise<DriverView> {
    return this.drivers.getView(id);
  }

  // Per-trip earnings ledger: full take-home + the explicit $0 commission line.
  @Get(':id/rides/:rideId/earnings')
  tripEarnings(
    @Param('rideId') rideId: string,
  ): Promise<TripEarningsView> {
    return this.earnings.tripEarnings(rideId);
  }

  // SCRUM-241 driver take-home ledger screen: locked upfront fare, the flat
  // subscription-fee line item as the ONLY deduction ($0 per trip), and a
  // "You Keep" total equal to 100% of the fare — no percentage commission line.
  @Get(':id/rides/:rideId/ledger')
  tripLedger(
    @Param('rideId') rideId: string,
  ): Promise<TakeHomeLedgerView> {
    return this.earnings.tripTakeHomeLedger(rideId);
  }

  // Session-end summary: cumulative take-home + "you kept 100% vs $X" delta.
  @Get(':id/earnings/summary')
  summary(@Param('id') id: string): Promise<DriverEarningsSummary> {
    return this.earnings.driverSummary(id);
  }

  // Driver-side repeat-supply signal.
  @Get(':id/repeat-status')
  repeatStatus(
    @Param('id') id: string,
    @Query('region') region: string,
  ): Promise<RepeatStatus> {
    return this.rides.driverRepeatStatus(id, region);
  }
}
