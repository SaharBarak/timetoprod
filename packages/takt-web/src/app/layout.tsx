import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'TAKT — Agentic Task Cost Calibration',
  description: 'Stop estimating. Start knowing. The ground truth on what agents actually cost.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
