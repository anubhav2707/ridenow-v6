import type { ReactNode } from 'react';

export const metadata = {
  title: 'RideNow — Driver',
  description: 'Accept rides, start trips with OTP, track earnings.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
