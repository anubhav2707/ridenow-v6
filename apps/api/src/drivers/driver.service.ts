import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CLOCK, type Clock } from '../clock/clock';
import { ENV, type Env } from '../config/env';
import {
  RIDE_REPOSITORY,
  type DriverRow,
  type RideRepository,
} from '../persistence/repository';

export interface RegisterDriverInput {
  phone: string;
  displayName: string;
  region: string;
}

export interface DriverView {
  id: string;
  phone: string;
  displayName: string;
  region: string;
  subscriptionStatus: string;
  createdAt: string;
}

@Injectable()
export class DriverService {
  constructor(
    @Inject(RIDE_REPOSITORY) private readonly repo: RideRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async register(input: RegisterDriverInput): Promise<DriverView> {
    if (!input.phone) throw new BadRequestException('phone is required');
    if (!input.displayName) {
      throw new BadRequestException('displayName is required');
    }
    if (input.region !== this.env.activeRegion) {
      throw new BadRequestException(
        `region '${input.region}' is not served (active region: ${this.env.activeRegion})`,
      );
    }
    const driver: DriverRow = {
      id: randomUUID(),
      phone: input.phone,
      displayName: input.displayName,
      region: input.region,
      // Flat-fee subscription model: an active subscription = keep 100% of fares.
      subscriptionStatus: 'active',
      createdAt: this.clock.now(),
    };
    const saved = await this.repo.upsertDriver(driver);
    return toDriverView(saved);
  }

  async getView(id: string): Promise<DriverView> {
    const driver = await this.repo.getDriver(id);
    if (!driver) throw new NotFoundException(`driver ${id} not found`);
    return toDriverView(driver);
  }
}

export function toDriverView(driver: DriverRow): DriverView {
  return {
    id: driver.id,
    phone: driver.phone,
    displayName: driver.displayName,
    region: driver.region,
    subscriptionStatus: driver.subscriptionStatus,
    createdAt: driver.createdAt.toISOString(),
  };
}
