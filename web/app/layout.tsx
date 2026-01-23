import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { ThemeProvider } from "@/components/core/theme-provider";
import "./globals.css";

const inter = localFont({
	src: "./fonts/Inter.woff2",
	variable: "--font-inter",
});

const lilex = localFont({
	src: "./fonts/Lilex.woff2",
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
			<body className={`${inter.variable} ${lilex.variable} font-sans antialiased`}>
				<ThemeProvider>
					<NuqsAdapter>{children}</NuqsAdapter>
				</ThemeProvider>
			</body>
		</html>
	);
}
