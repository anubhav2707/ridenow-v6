import { NotFoundException } from '@nestjs/common';
import { DriverController } from './driver.controller';
import type {
  DriverService,
  DriverView,
  OnboardDriverInput,
  RegisterDriverInput,
} from './driver.service';
import type {
  DriverEarningsSummary,
  EarningsService,
  TakeHomeLedgerView,
  TripEarningsView,
} from '../earnings/earnings.service';
import type { RepeatStatus, RideService } from '../rides/ride.service';

// Unit test for the thin SCRUM-241 driver controller. It owns no logic beyond
// routing, so we mock the three collaborating services and assert it (a) wires
// each endpoint to the right service method, (b) forwards the correct route
// param, and (c) surfaces service errors unchanged.
describe('DriverController', () => {
  let controller: DriverController;
  let drivers: jest.Mocked<Pick<DriverService, 'register' | 'onboard' | 'getView'>>;
  let earnings: jest.Mocked<
    Pick<EarningsService, 'tripEarnings' | 'tripTakeHomeLedger' | 'driverSummary'>
  >;
  let rides: jest.Mocked<Pick<RideService, 'driverRepeatStatus'>>;

  beforeEach(() => {
    drivers = {
      register: jest.fn(),
      onboard: jest.fn(),
      getView: jest.fn(),
    };
    earnings = {
      tripEarnings: jest.fn(),
      tripTakeHomeLedger: jest.fn(),
      driverSummary: jest.fn(),
    };
    rides = {
      driverRepeatStatus: jest.fn(),
    };

    controller = new DriverController(
      drivers as unknown as DriverService,
      earnings as unknown as EarningsService,
      rides as unknown as RideService,
    );
  });

  describe('POST /drivers/onboarding (SCRUM-241 lightweight onboarding)', () => {
    const input = {
      displayName: 'Asha Rao',
      phone: '+15550101',
      region: 'sea',
      vehicleMake: 'Toyota',
      vehicleModel: 'Prius',
      vehiclePlate: 'ABC-1234',
      plan: 'flat-monthly',
    } as unknown as OnboardDriverInput;

    // Happy path: the new endpoint delegates to onboard() and returns its view.
    it('delegates to DriverService.onboard and returns the activated driver view', async () => {
      const view = {
        id: 'drv_1',
        displayName: 'Asha Rao',
        active: true,
        plan: 'flat-monthly',
      } as unknown as DriverView;
      drivers.onboard.mockResolvedValue(view);

      await expect(controller.onboard(input)).resolves.toBe(view);
      expect(drivers.onboard).toHaveBeenCalledTimes(1);
      expect(drivers.onboard).toHaveBeenCalledWith(input);
    });

    // Edge: onboarding is a distinct path from legacy register() and must not
    // fall through to it.
    it('does not fall through to the legacy register() path', async () => {
      drivers.onboard.mockResolvedValue({} as unknown as DriverView);

      await controller.onboard(input);

      expect(drivers.register).not.toHaveBeenCalled();
    });

    // Error path: service rejections propagate to the caller.
    it('propagates errors raised by the service', async () => {
      drivers.onboard.mockRejectedValue(new Error('invalid plan'));

      await expect(controller.onboard(input)).rejects.toThrow('invalid plan');
    });
  });

  describe('GET /drivers/:id/rides/:rideId/ledger (SCRUM-241 take-home ledger)', () => {
    // Edge most likely to break: the route carries both :id and :rideId but the
    // handler must forward the rideId, not the driver id.
    it('forwards the rideId (not the driver id) to EarningsService.tripTakeHomeLedger', async () => {
      const ledger = {
        rideId: 'ride_42',
        youKeepCents: 1800,
        perTripDeductionCents: 0,
      } as unknown as TakeHomeLedgerView;
      earnings.tripTakeHomeLedger.mockResolvedValue(ledger);

      await expect(controller.tripLedger('ride_42')).resolves.toBe(ledger);
      expect(earnings.tripTakeHomeLedger).toHaveBeenCalledWith('ride_42');
    });

    // Error path: an unknown ride surfaces as NotFoundException.
    it('propagates NotFoundException for an unknown ride', async () => {
      earnings.tripTakeHomeLedger.mockRejectedValue(
        new NotFoundException('ride ride_x not found'),
      );

      await expect(controller.tripLedger('ride_x')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('GET /drivers/:id/rides/:rideId/earnings', () => {
    it('forwards the rideId to EarningsService.tripEarnings', async () => {
      const earningsView = { rideId: 'ride_7' } as unknown as TripEarningsView;
      earnings.tripEarnings.mockResolvedValue(earningsView);

      await expect(controller.tripEarnings('ride_7')).resolves.toBe(earningsView);
      expect(earnings.tripEarnings).toHaveBeenCalledWith('ride_7');
    });
  });

  describe('GET /drivers/:id/earnings/summary', () => {
    it('delegates to EarningsService.driverSummary with the driver id', async () => {
      const summary = {
        driverId: 'drv_1',
        trips: 3,
      } as unknown as DriverEarningsSummary;
      earnings.driverSummary.mockResolvedValue(summary);

      await expect(controller.summary('drv_1')).resolves.toBe(summary);
      expect(earnings.driverSummary).toHaveBeenCalledWith('drv_1');
    });
  });

  describe('GET /drivers/:id/repeat-status', () => {
    it('passes the driver id and region query through to RideService', async () => {
      const status = { region: 'sea', repeat: true } as unknown as RepeatStatus;
      rides.driverRepeatStatus.mockResolvedValue(status);

      await expect(controller.repeatStatus('drv_1', 'sea')).resolves.toBe(status);
      expect(rides.driverRepeatStatus).toHaveBeenCalledWith('drv_1', 'sea');
    });
  });

  describe('POST /drivers and GET /drivers/:id', () => {
    it('register() delegates to DriverService.register', async () => {
      const body = {
        phone: '+15550202',
        displayName: 'Ravi',
      } as unknown as RegisterDriverInput;
      const view = { id: 'drv_2' } as unknown as DriverView;
      drivers.register.mockResolvedValue(view);

      await expect(controller.register(body)).resolves.toBe(view);
      expect(drivers.register).toHaveBeenCalledWith(body);
    });

    it('getOne() delegates to DriverService.getView', async () => {
      const view = { id: 'drv_3' } as unknown as DriverView;
      drivers.getView.mockResolvedValue(view);

      await expect(controller.getOne('drv_3')).resolves.toBe(view);
      expect(drivers.getView).toHaveBeenCalledWith('drv_3');
    });
  });
});
