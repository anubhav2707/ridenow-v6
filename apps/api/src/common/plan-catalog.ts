import type { Cents } from '../money/money';

// The single source of truth for the flat-fee subscription model. RideNow does
// NOT take a percentage commission: a driver pays a flat monthly subscription
// and keeps 100% of every fare. There is intentionally no percentage rate
// anywhere in this catalog.
export interface PlanDefinition {
  id: string;
  label: string;
  /** Flat monthly subscription fee in integer minor units. Billed monthly, never per-trip. */
  subscriptionFeeCents: Cents;
}

export const PLAN_CATALOG: Record<string, PlanDefinition> = {
  flat_monthly: {
    id: 'flat_monthly',
    label: 'Flat monthly subscription',
    subscriptionFeeCents: 4900,
  },
};

export const DEFAULT_PLAN_ID = 'flat_monthly';

export function getPlan(id: string): PlanDefinition | undefined {
  return PLAN_CATALOG[id];
}

export const PLAN_IDS = Object.keys(PLAN_CATALOG);
