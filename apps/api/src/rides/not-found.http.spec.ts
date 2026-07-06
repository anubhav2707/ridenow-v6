import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';

// SCRUM-243 adds several public routes that take a resource id. Each one MUST
// fail closed with a 404 (never a 500 or a silent 200) when the id is unknown.
// These assertions run through the REAL HTTP stack — routing, pipes, and Nest's
// exception filter — not the service methods directly, so they catch wiring or
// serialization regressions a direct call would miss.
const UNKNOWN = '00000000-0000-0000-0000-000000000000';

interface ErrorBody {
  statusCode?: number;
  error?: string;
}

interface Res {
  status: number;
  body: ErrorBody;
}

async function req(
  baseUrl: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<Res> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text ? (JSON.parse(text) as ErrorBody) : {},
  };
}

describe('unknown resource ids fail closed with 404 (HTTP)', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    const { port } = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  async function expect404(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<void> {
    const res = await req(baseUrl, method, path, body);
    expect(res.status).toBe(404);
    expect(res.body.statusCode).toBe(404);
    expect(res.body.error).toBe('Not Found');
  }

  it('GET /quotes/:id returns 404 for an unknown quote', async () => {
    await expect404('GET', `/quotes/${UNKNOWN}`);
  });

  it('GET /rides/:id returns 404 for an unknown ride', async () => {
    await expect404('GET', `/rides/${UNKNOWN}`);
  });

  it('GET /rides/:id/receipt returns 404 for an unknown ride', async () => {
    await expect404('GET', `/rides/${UNKNOWN}/receipt`);
  });

  it('POST /rides/:id/accept returns 404 for an unknown ride', async () => {
    await expect404('POST', `/rides/${UNKNOWN}/accept`, { driverId: UNKNOWN });
  });

  it('POST /rides/:id/complete returns 404 for an unknown ride', async () => {
    await expect404('POST', `/rides/${UNKNOWN}/complete`);
  });

  it('GET /drivers/:id returns 404 for an unknown driver', async () => {
    await expect404('GET', `/drivers/${UNKNOWN}`);
  });

  it('GET /drivers/:id/rides/:rideId/earnings returns 404 for an unknown ride', async () => {
    await expect404('GET', `/drivers/${UNKNOWN}/rides/${UNKNOWN}/earnings`);
  });

  it('GET /drivers/:id/earnings/summary returns 404 for an unknown driver', async () => {
    await expect404('GET', `/drivers/${UNKNOWN}/earnings/summary`);
  });
});
