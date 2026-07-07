import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CLOCK, type Clock } from '../clock/clock';
import { getPlan, PLAN_IDS } from '../common/plan-catalog';
import { requireFields } from '../common/validation';
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

/** SCRUM-241 lightweight onboarding payload. */
export interface OnboardDriverInput {
  name: string;
  phone: string;
  vehicleMake: string;
  vehicleModel: string;
  vehiclePlate: string;
  plan: string;
  region?: string;
}

export interface DriverView {
  id: string;
  phone: string;
  displayName: string;
  region: string;
  subscriptionStatus: string;
  /** True the instant onboarding completes — the driver may receive offers now. */
  active: boolean;
  vehicleMake: string | null;
  vehicleModel: string | null;
  vehiclePlate: string | null;
  plan: string | null;
  subscriptionFeeCents: number;
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
      vehicleMake: null,
      vehicleModel: null,
      vehiclePlate: null,
      plan: null,
      subscriptionFeeCents: 0,
      active: true,
      lastLat: null,
      lastLng: null,
      lastLocationAt: null,
      createdAt: this.clock.now(),
    };
    const saved = await this.repo.upsertDriver(driver);
    return toDriverView(saved);
  }

  /**
   * Lightweight driver onboarding: name + phone + vehicle details + a chosen
   * flat-fee plan. The account is activated immediately and is eligible to
   * receive ride offers — there is deliberately NO automated KYC gate in this
   * flow (KYC/background checks are an explicit later item, not MVP).
   */
  async onboard(input: OnboardDriverInput): Promise<DriverView> {
    // Fail closed on any missing required field BEFORE creating anything.
    requireFields(input as unknown as Record<string, unknown>, [
      'name',
      'phone',
      'vehicleMake',
      'vehicleModel',
      'vehiclePlate',
      'plan',
    ]);
    const plan = getPlan(input.plan);
    if (!plan) {
      throw new BadRequestException({
        message: `unknown plan '${input.plan}' — choose one of: ${PLAN_IDS.join(', ')}`,
        error: 'Bad Request',
        statusCode: 400,
        fields: ['plan'],
      });
    }
    const region = input.region?.trim() || this.env.activeRegion;
    if (region !== this.env.activeRegion) {
      throw new BadRequestException(
        `region '${region}' is not served (active region: ${this.env.activeRegion})`,
      );
    }
    const driver: DriverRow = {
      id: randomUUID(),
      phone: input.phone,
      displayName: input.name,
      region,
      subscriptionStatus: 'active',
      vehicleMake: input.vehicleMake,
      vehicleModel: input.vehicleModel,
      vehiclePlate: input.vehiclePlate,
      plan: plan.id,
      subscriptionFeeCents: plan.subscriptionFeeCents,
      // Activated immediately — no KYC gate.
      active: true,
      lastLat: null,
      lastLng: null,
      lastLocationAt: null,
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
    active: driver.active,
    vehicleMake: driver.vehicleMake,
    vehicleModel: driver.vehicleModel,
    vehiclePlate: driver.vehiclePlate,
    plan: driver.plan,
    subscriptionFeeCents: driver.subscriptionFeeCents,
    createdAt: driver.createdAt.toISOString(),
  };
}