import { db, queryClient } from './client';
import { rides } from './schema';

async function seed(): Promise<void> {
  await db.insert(rides).values({
    riderPhone: '+15550100001',
    status: 'quoted',
  });
  console.log('Seeded demo ride.');
  await queryClient.end();
}

void seed();
