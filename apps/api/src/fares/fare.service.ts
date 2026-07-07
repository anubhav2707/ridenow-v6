import { Inject, Injectable } from '@nestjs/common';
import {
  assertNonNegativeInt,
  sumCents,
  type Cents,
} from '../money/money';
import { ENV, type Env } from '../config/env';

export type FareComponentKind = 'base' | 'distance' | 'time' | 'booking_fee';

export interface FareComponent {
  kind: FareComponentKind;
  label: string;
  amountCents: Cents;
  sortOrder: number;
}

export interface FareBreakdown {
  components: FareComponent[];
  totalCents: Cents;
  currency: string;
}

export interface FareInput {
  distanceMeters: number;
  durationSeconds: number;
}

/**
 * Server-authoritative fare engine. Given a route it produces an itemized,
 * integer-cent breakdown whose components sum EXACTLY to the total. The client
 * never computes or influences price — it only sends locations.
 */
@Injectable()
export class FareService {
  constructor(@Inject(ENV) private readonly env: Env) {}

  price(input: FareInput): FareBreakdown {
    const { fare, currency } = this.env;
    const distanceKm = input.distanceMeters / 1000;
    const durationMin = input.durationSeconds / 60;

    const components: FareComponent[] = [
      {
        kind: 'base',
        label: 'Base fare',
        amountCents: fare.baseCents,
        sortOrder: 0,
      },
      {
        kind: 'distance',
        label: `Distance (${distanceKm.toFixed(2)} km)`,
        amountCents: Math.round(distanceKm * fare.perKmCents),
        sortOrder: 1,
      },
      {
        kind: 'time',
        label: `Time (${durationMin.toFixed(1)} min)`,
        amountCents: Math.round(durationMin * fare.perMinCents),
        sortOrder: 2,
      },
      {
        kind: 'booking_fee',
        label: 'Booking fee',
        amountCents: fare.bookingFeeCents,
        sortOrder: 3,
      },
    ];

    for (const component of components) {
      // Rounding above always yields integers, but assert to make the
      // "integer cents everywhere" invariant a hard guarantee.
      assertNonNegativeInt(component.amountCents);
    }

    const totalCents = sumCents(components.map((c) => c.amountCents));
    return { components, totalCents, currency };
  }
}
