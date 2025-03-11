import type { Metadata } from "next";
import { Space_Grotesk } from "next/font/google";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Techulus Cloud",
  description: "Simple cloud deployment for your projects",
  metadataBase: new URL("https://techulus.cloud"),
  openGraph: {
    title: "Techulus Cloud",
    description: "Simple cloud deployment for your projects",
    type: "website",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "Techulus Cloud - Simple cloud deployment for your projects"
      }
    ]
  },
  twitter: {
    card: "summary_large_image",
    title: "Techulus Cloud",
    description: "Simple cloud deployment for your projects",
    images: ["/og.png"]
  },
  icons: {
    icon: "/favicon.ico",
    apple: "/apple-touch-icon.png"
  },
  manifest: "/site.webmanifest",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${spaceGrotesk.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
