import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import { Toaster } from "sonner";

const mainFont = Geist({
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
				alt: "Techulus Cloud - Simple cloud deployment for your projects",
			},
		],
	},
	twitter: {
		card: "summary_large_image",
		title: "Techulus Cloud",
		description: "Simple cloud deployment for your projects",
		images: ["/og.png"],
	},
	icons: {
		icon: "/favicon.ico",
		apple: "/apple-touch-icon.png",
	},
	manifest: "/site.webmanifest",
};

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<html
			lang="en"
			className="bg-white lg:bg-zinc-100 dark:bg-zinc-900 dark:lg:bg-zinc-950"
		>
			<body className={`${mainFont.className} antialiased`}>
				{children}
				<Toaster position="bottom-center" />
			</body>
		</html>
	);
}
