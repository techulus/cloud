import type { Metadata, Viewport } from "next";
import { IBM_Plex_Sans } from "next/font/google";
import localFont from "next/font/local";
import { ThemeProvider } from "@/components/core/theme-provider";
import "./globals.css";

const ibmPlexSans = IBM_Plex_Sans({
	subsets: ["latin"],
	weight: ["400", "500", "600", "700"],
	variable: "--font-ibm-plex-sans",
});

const lilex = localFont({
	src: "./fonts/Lilex/Lilex[wght].woff2",
	variable: "--font-lilex",
});

export const metadata: Metadata = {
	title: "Techulus Cloud",
	description: "Stateless container deployment platform",
};

export const viewport: Viewport = {
	themeColor: [
		{ media: "(prefers-color-scheme: light)", color: "#f8fafc" },
		{ media: "(prefers-color-scheme: dark)", color: "#0f0d1a" },
	],
};

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<html lang="en" suppressHydrationWarning>
			<body
				className={`${ibmPlexSans.variable} ${lilex.variable} font-sans antialiased`}
			>
				<ThemeProvider>{children}</ThemeProvider>
			</body>
		</html>
	);
}
