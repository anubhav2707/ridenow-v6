import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
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

describe('GET /health (HTTP integration)', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();

    app = moduleRef.createNestApplication();
    // listen(0) boots the full HTTP stack on a random port so we exercise
    // routing, the Nest pipeline and JSON serialization end-to-end.
    await app.listen(0);
    const { port } = app.getHttpServer().address() as { port: number };
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves 200 and a JSON body over the real HTTP stack', async () => {
    const res = await fetch(`${baseUrl}/health`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);

    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('ridenow-api');
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });
});
