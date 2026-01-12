"use client";

import { ProgressProvider } from "@bprogress/next/app";
import { ThemeProvider as NextThemesProvider } from "next-themes";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
	return (
		<NextThemesProvider
			attribute="class"
			defaultTheme="system"
			enableSystem
			storageKey=""
		>
			<ProgressProvider
				height="3px"
				color="#4f7df3"
				options={{ showSpinner: false }}
			>
				{children}
			</ProgressProvider>
		</NextThemesProvider>
	);
}
