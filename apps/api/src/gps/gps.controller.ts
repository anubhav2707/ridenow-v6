import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  GpsService,
  type PingView,
  type RecordPingInput,
} from './gps.service';

// GPS ping ingest for a trip. Shares the `/rides` prefix with RideController;
// routes do not overlap.
@Controller('rides')
export class GpsController {
  constructor(private readonly gps: GpsService) {}

  @Post(':id/pings')
  record(
    @Param('id') id: string,
    @Body() body: RecordPingInput,
  ): Promise<PingView> {
    return this.gps.record(id, body);
  }

  @Get(':id/pings')
  list(@Param('id') id: string): Promise<PingView[]> {
    return this.gps.list(id);
  }
}
