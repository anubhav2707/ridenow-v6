import 'reflect-metadata';
import { get } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';

interface HttpResult {
  status: number;
  body: string;
}

function httpGet(url: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    }).on('error', reject);
  });
}

describe('GET /health (HTTP)', () => {
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

  it('responds 200 with an ok status payload', async () => {
    const res = await httpGet(`${baseUrl}/health`);
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body) as { status: string; service: string };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('ridenow-api');
  });
});
