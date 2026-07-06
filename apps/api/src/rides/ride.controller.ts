import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  RideService,
  type CompleteResult,
  type ConfirmResult,
  type ReceiptView,
  type RideView,
} from './ride.service';

interface ConfirmBody {
  quoteId: string;
  riderPhone: string;
  amountCents?: number;
}

interface AcceptBody {
  driverId: string;
}

interface StartBody {
  otp: string;
}

@Controller('rides')
export class RideController {
  constructor(private readonly rides: RideService) {}

  @Post()
  confirm(@Body() body: ConfirmBody): Promise<ConfirmResult> {
    return this.rides.confirm(body);
  }

  @Get(':id')
  getOne(@Param('id') id: string): Promise<RideView> {
    return this.rides.getRideView(id);
  }

  @Get(':id/receipt')
  receipt(@Param('id') id: string): Promise<ReceiptView> {
    return this.rides.receipt(id);
  }

  @Post(':id/accept')
  accept(
    @Param('id') id: string,
    @Body() body: AcceptBody,
  ): Promise<RideView> {
    return this.rides.accept(id, body.driverId);
  }

  // OTP trip start: driver enters the code the rider read aloud.
  @Post(':id/start')
  start(
    @Param('id') id: string,
    @Body() body: StartBody,
  ): Promise<RideView> {
    return this.rides.startTrip(id, body?.otp);
  }

  @Post(':id/complete')
  complete(@Param('id') id: string): Promise<CompleteResult> {
    return this.rides.complete(id);
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string): Promise<RideView> {
    return this.rides.cancel(id);
  }
}
