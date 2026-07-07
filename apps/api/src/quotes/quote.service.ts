import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CLOCK, type Clock } from '../clock/clock';
import { ENV, type Env } from '../config/env';
import { FareService } from '../fares/fare.service';
import { sumCents } from '../money/money';
import {
  RIDE_REPOSITORY,
  type QuoteComponentRow,
  type QuoteRow,
  type RideRepository,
} from '../persistence/repository';
import { ROUTING, type LatLng, type RoutingService } from '../routing/routing';

export interface LocationInput {
  label: string;
  lat: number;
  lng: number;
}

export interface CreateQuoteInput {
  riderPhone: string;
  region: string;
  pickup: LocationInput;
  dropoff: LocationInput;
}

export interface QuoteView {
  id: string;
  riderPhone: string;
  region: string;
  currency: string;
  totalCents: number;
  distanceMeters: number;
  durationSeconds: number;
  expiresAt: string;
  createdAt: string;
  /**
   * Explicit no-surge indication. This MVP has NO surge/dynamic pricing (out of
   * scope), so every quote is a plain, locked fare. Making it explicit in the
   * payload lets the rider UI promise "no surge" truthfully.
   */
  surge: {
    applied: false;
    multiplier: 1;
  };
  /** True: this itemized total is locked and will not change after Confirm. */
  locked: true;
  pickup: LocationInput;
  dropoff: LocationInput;
  components: Array<{
    kind: string;
    label: string;
    amountCents: number;
    sortOrder: number;
  }>;
}

@Injectable()
export class QuoteService {
  constructor(
    @Inject(RIDE_REPOSITORY) private readonly repo: RideRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
    @Inject(ROUTING) private readonly routing: RoutingService,
    private readonly fares: FareService,
  ) {}

  async createQuote(input: CreateQuoteInput): Promise<QuoteView> {
    this.validate(input);
    if (input.region !== this.env.activeRegion) {
      // Single feature-flagged geography — everything else is out of scope.
      throw new BadRequestException(
        `region '${input.region}' is not served (active region: ${this.env.activeRegion})`,
      );
    }

    const pickup: LatLng = { lat: input.pickup.lat, lng: input.pickup.lng };
    const dropoff: LatLng = { lat: input.dropoff.lat, lng: input.dropoff.lng };
    const route = await this.routing.route(pickup, dropoff);
    const breakdown = this.fares.price(route);

    // Defensive: the itemized components must sum EXACTLY to the locked total.
    const componentsTotal = sumCents(
      breakdown.components.map((c) => c.amountCents),
    );
    if (componentsTotal !== breakdown.totalCents) {
      throw new Error(
        `fare components (${componentsTotal}) do not sum to total (${breakdown.totalCents})`,
      );
    }

    const now = this.clock.now();
    const id = randomUUID();
    const quote: QuoteRow = {
      id,
      riderPhone: input.riderPhone,
      region: input.region,
      pickupLabel: input.pickup.label,
      pickupLat: input.pickup.lat,
      pickupLng: input.pickup.lng,
      dropoffLabel: input.dropoff.label,
      dropoffLat: input.dropoff.lat,
      dropoffLng: input.dropoff.lng,
      distanceMeters: route.distanceMeters,
      durationSeconds: route.durationSeconds,
      currency: breakdown.currency,
      totalCents: breakdown.totalCents,
      status: 'active',
      expiresAt: new Date(now.getTime() + this.env.quoteTtlSeconds * 1000),
      createdAt: now,
    };
    const components: QuoteComponentRow[] = breakdown.components.map((c) => ({
      id: randomUUID(),
      quoteId: id,
      kind: c.kind,
      label: c.label,
      amountCents: c.amountCents,
      sortOrder: c.sortOrder,
    }));

    await this.repo.insertQuote(quote, components);
    return toQuoteView(quote, components);
  }

  async getQuoteView(id: string): Promise<QuoteView> {
    const found = await this.repo.getQuote(id);
    if (!found) throw new NotFoundException(`quote ${id} not found`);
    return toQuoteView(found.quote, found.components);
  }

  private validate(input: CreateQuoteInput): void {
    if (!input.riderPhone || typeof input.riderPhone !== 'string') {
      throw new BadRequestException('riderPhone is required');
    }
    for (const [name, loc] of [
      ['pickup', input.pickup],
      ['dropoff', input.dropoff],
    ] as const) {
      if (
        !loc ||
        typeof loc.lat !== 'number' ||
        typeof loc.lng !== 'number' ||
        Number.isNaN(loc.lat) ||
        Number.isNaN(loc.lng)
      ) {
        throw new BadRequestException(`${name} must have numeric lat/lng`);
      }
    }
  }
}

export function toQuoteView(
  quote: QuoteRow,
  components: QuoteComponentRow[],
): QuoteView {
  return {
    id: quote.id,
    riderPhone: quote.riderPhone,
    region: quote.region,
    currency: quote.currency,
    totalCents: quote.totalCents,
    distanceMeters: quote.distanceMeters,
    durationSeconds: quote.durationSeconds,
    expiresAt: quote.expiresAt.toISOString(),
    createdAt: quote.createdAt.toISOString(),
    surge: { applied: false, multiplier: 1 },
    locked: true,
    pickup: {
      label: quote.pickupLabel,
      lat: quote.pickupLat,
      lng: quote.pickupLng,
    },
    dropoff: {
      label: quote.dropoffLabel,
      lat: quote.dropoffLat,
      lng: quote.dropoffLng,
    },
    components: [...components]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((c) => ({
        kind: c.kind,
        label: c.label,
        amountCents: c.amountCents,
        sortOrder: c.sortOrder,
      })),
  };
}
