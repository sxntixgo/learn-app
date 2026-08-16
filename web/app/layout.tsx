import type { Metadata } from 'next';
import { ReactNode } from 'react';
import { IBM_Plex_Mono, Libre_Franklin, Source_Serif_4 } from 'next/font/google';
import './globals.css';

// next/font self-hosts these at build time (downloaded once during `next
// build`/`next dev`, then served from our own origin) — no runtime request
// to fonts.googleapis.com or any other third-party host.
const libreFranklin = Libre_Franklin({
  subsets: ['latin'],
  weight: ['500', '700'],
  variable: '--font-sans',
  display: 'swap',
});

const sourceSerif4 = Source_Serif_4({
  subsets: ['latin'],
  weight: ['400'],
  variable: '--font-serif',
  display: 'swap',
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Learn App',
  description: 'A self-hosted learning platform',
};

export default function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${libreFranklin.variable} ${sourceSerif4.variable} ${ibmPlexMono.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
