import 'reflect-metadata';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  const controller = new HealthController();

  it('returns an ok status payload', () => {
    const result = controller.check();
    expect(result.status).toBe('ok');
    expect(result.service).toBe('ridenow-api');
  });

  it('includes a valid ISO timestamp', () => {
    const result = controller.check();
    expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
  });
});
