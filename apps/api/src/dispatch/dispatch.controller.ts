import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { DispatchService } from './dispatch.service';
import { RepeatLiquidityService } from './repeat-liquidity.service';
import type {
  AssignmentView,
  DriverCandidate,
  OpenRequestView,
  RepeatLiquidityReport,
} from './dispatch.types';

interface AssignBody {
  /** Optional: operator picks a specific driver. Omit for greedy nearest-available. */
  driverId?: string;
}

interface LocationBody {
  lat: number;
  lng: number;
}

/**
 * The lightweight operator dispatch console (semi-automated). Lists open
 * requests, ranks nearby available drivers, performs one-click / greedy assign,
 * and exposes the bilateral repeat-liquidity metric. Driver location reporting
 * feeds the proximity ranking.
 */
@Controller('dispatch')
export class DispatchController {
  constructor(
    private readonly dispatch: DispatchService,
    private readonly liquidity: RepeatLiquidityService,
  ) {}

  @Get('open-requests')
  openRequests(
    @Query('region') region?: string,
  ): Promise<OpenRequestView[]> {
    return this.dispatch.listOpenRequests(region);
  }

  @Get('rides/:rideId/candidates')
  candidates(
    @Param('rideId') rideId: string,
  ): Promise<DriverCandidate[]> {
    return this.dispatch.rankCandidates(rideId);
  }

  @Post('rides/:rideId/assign')
  assign(
    @Param('rideId') rideId: string,
    @Body() body: AssignBody,
  ): Promise<AssignmentView> {
    return this.dispatch.assign(rideId, body?.driverId);
  }

  @Post('drivers/:id/location')
  location(
    @Param('id') id: string,
    @Body() body: LocationBody,
  ): Promise<{ driverId: string; lat: number; lng: number; at: string }> {
    const { lat, lng } = body ?? ({} as LocationBody);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new BadRequestException('lat and lng must be finite numbers');
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      throw new BadRequestException('lat must be in [-90,90] and lng in [-180,180]');
    }
    return this.dispatch.updateDriverLocation(id, lat, lng);
  }

  @Get('repeat-liquidity')
  repeatLiquidity(
    @Query('region') region?: string,
  ): Promise<RepeatLiquidityReport> {
    return this.liquidity.computeRepeatLiquidity(region);
  }
}
