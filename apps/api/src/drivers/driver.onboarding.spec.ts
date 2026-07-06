import { BadRequestException } from '@nestjs/common';
import { getPlan } from '../common/plan-catalog';
import { makeHarness, offerRide } from '../testing/harness';
import type { OnboardDriverInput } from './driver.service';

const VALID: OnboardDriverInput = {
  name: 'Dana Driver',
  phone: '+15550107777',
  vehicleMake: 'Honda',
  vehicleModel: 'Civic',
  vehiclePlate: 'PLATE-1',
  plan: 'flat_monthly',
};

describe('driver lightweight onboarding (SCRUM-241)', () => {
  it('AC1: activates the account immediately with vehicle + flat-fee plan and NO KYC gate', async () => {
    const h = makeHarness();
    const driver = await h.drivers.onboard(VALID);

    expect(driver.id).toBeTruthy();
    expect(driver.displayName).toBe('Dana Driver');
    expect(driver.vehicleMake).toBe('Honda');
    expect(driver.vehicleModel).toBe('Civic');
    expect(driver.vehiclePlate).toBe('PLATE-1');
    expect(driver.plan).toBe('flat_monthly');
    // Flat fee copied from the catalog — a fee, never a percentage.
    expect(driver.subscriptionFeeCents).toBe(
      getPlan('flat_monthly')?.subscriptionFeeCents,
    );
    // Activated the instant onboarding completes: no KYC/verification step.
    expect(driver.active).toBe(true);
  });

  it('AC1: an onboarded driver is immediately eligible to accept a ride offer', async () => {
    const h = makeHarness();
    const driver = await h.drivers.onboard(VALID);
    const { rideId } = await offerRide(h);

    // No verification wait — the just-onboarded driver can claim the ride now.
    const accepted = await h.rides.accept(rideId, driver.id);
    expect(accepted.status).toBe('accepted');
    expect(accepted.driverId).toBe(driver.id);
  });

  it.each(['name', 'phone', 'vehiclePlate', 'plan'] as const)(
    'AC2: rejects onboarding missing "%s" with a 400 and creates NO driver',
    async (field) => {
      const h = makeHarness();
      const body = { ...VALID, phone: '+1555010' + field.length + '000' };
      delete (body as Record<string, unknown>)[field];

      await expect(h.drivers.onboard(body)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      // Nothing was persisted for this submission.
      const persisted = await h.repo.getDriverByPhone(body.phone);
      expect(persisted).toBeNull();
    },
  );

  it('AC2: the 400 names the missing fields', async () => {
    const h = makeHarness();
    const body = { ...VALID, phone: '+15550106666' };
    delete (body as Record<string, unknown>).vehiclePlate;

    await expect(h.drivers.onboard(body)).rejects.toMatchObject({
      response: { fields: ['vehiclePlate'] },
    });
  });

  it('rejects an unknown subscription plan with a 400 and creates no driver', async () => {
    const h = makeHarness();
    const body = { ...VALID, phone: '+15550105555', plan: 'percentage_cut' };
    await expect(h.drivers.onboard(body)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(await h.repo.getDriverByPhone(body.phone)).toBeNull();
  });
});
