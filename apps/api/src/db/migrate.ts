import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { db, queryClient } from './client';

async function main(): Promise<void> {
  await migrate(db, { migrationsFolder: './drizzle' });
  await queryClient.end();
  console.log('Migrations applied.');
}

void main();
