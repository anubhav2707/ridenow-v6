import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { assertStripeMode, loadEnv } from './config/env';

async function bootstrap(): Promise<void> {
  // Money-safety gate: refuse to boot if the Stripe key's livemode disagrees with
  // the server-side STRIPE_MODE flag. No-op for the default fake gateway.
  assertStripeMode(loadEnv());

  const app = await NestFactory.create(AppModule);
  app.enableCors();
  // Stable error envelope + no stack/secret leakage on unexpected failures.
  app.useGlobalFilters(new HttpExceptionFilter());
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`RideNow API listening on http://localhost:${port}`);
}

void bootstrap();
