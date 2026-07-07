import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CLOCK, type Clock } from '../clock/clock';
import {
  RIDE_REPOSITORY,
  type GpsPingRow,
  type RideRepository,
} from '../persistence/repository';

export interface RecordPingInput {
  lat: number;
  lng: number;
  /** Client-reported ISO timestamp the fix was taken; defaults to server time. */
  recordedAt?: string;
}

export interface PingView {
  id: string;
  rideId: string;
  lat: number;
  lng: number;
  recordedAt: string;
  receivedAt: string;
  seq: number;
}

/**
 * GPS ping ingest for an in-progress trip. Kept deliberately off the money path:
 * a ping only persists a coordinate + timestamp against the trip. Pings are
 * accepted ONLY while the ride is 'in_progress' (i.e. after OTP trip-start), and
 * the server supports updates at least as often as every 10 seconds — each is a
 * new persisted (ride_id, lat, lng, recorded_at) row.
 */
@Injectable()
export class GpsService {
  constructor(
    @Inject(RIDE_REPOSITORY) private readonly repo: RideRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async record(rideId: string, input: RecordPingInput): Promise<PingView> {
    const ride = await this.repo.getRide(rideId);
    if (!ride) throw new NotFoundException(`ride ${rideId} not found`);
    if (ride.status !== 'in_progress') {
      throw new ConflictException(
        `ride ${rideId} is not in progress (status '${ride.status}') — no GPS pings accepted`,
      );
    }
    if (
      typeof input?.lat !== 'number' ||
      typeof input?.lng !== 'number' ||
      Number.isNaN(input.lat) ||
      Number.isNaN(input.lng)
    ) {
      throw new BadRequestException('lat and lng are required numbers');
    }

    const receivedAt = this.clock.now();
    const recordedAt = parseTimestamp(input.recordedAt, receivedAt);
    const ping = await this.repo.recordPing({
      rideId,
      lat: input.lat,
      lng: input.lng,
      recordedAt,
      receivedAt,
    });
    return toPingView(ping);
  }

  async list(rideId: string): Promise<PingView[]> {
    const ride = await this.repo.getRide(rideId);
    if (!ride) throw new NotFoundException(`ride ${rideId} not found`);
    const pings = await this.repo.pingsForRide(rideId);
    return pings.map(toPingView);
  }
}

function parseTimestamp(value: string | undefined, fallback: Date): Date {
  if (!value) return fallback;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`invalid recordedAt timestamp: ${value}`);
  }
  return parsed;
}

function toPingView(ping: GpsPingRow): PingView {
  return {
    id: ping.id,
    rideId: ping.rideId,
    lat: ping.lat,
    lng: ping.lng,
    recordedAt: ping.recordedAt.toISOString(),
    receivedAt: ping.receivedAt.toISOString(),
    seq: ping.seq,
  };
}
