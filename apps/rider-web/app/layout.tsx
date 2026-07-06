import type { ReactNode } from 'react';

export const metadata = {
  title: 'RideNow — Rider',
  description: 'Book a ride with an upfront, transparent fare.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
