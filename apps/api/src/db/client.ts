import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const connectionString =
  process.env.DATABASE_URL ??
  'postgres://ridenow:ridenow@localhost:5432/ridenow';

export const queryClient = postgres(connectionString);
export const db = drizzle(queryClient, { schema });
