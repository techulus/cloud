"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Settings } from "lucide-react";
import {
	BreadcrumbDataProvider,
	useBreadcrumbs,
} from "@/components/core/breadcrumb-data";
import { OfflineServersBanner } from "@/components/offline-servers-banner";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { signOut, useSession } from "@/lib/auth-client";

function DashboardHeader({ email }: { email: string }) {
	const router = useRouter();
	const breadcrumbs = useBreadcrumbs();

	return (
		<header className="border-b">
			<div className="container max-w-full mx-auto px-4 h-14 flex items-center justify-between">
				<div className="flex items-center gap-3">
					<Link href="/dashboard" className="flex items-center">
						<Image
							src="/logo.png"
							alt="Techulus Cloud"
							className="h-6"
							width={24}
							height={24}
						/>
					</Link>
					{breadcrumbs.length > 0 ? (
						<nav className="flex items-center gap-2 text-sm">
							{breadcrumbs.map((crumb, index) => (
								<span key={crumb.href} className="flex items-center gap-2">
									<Link
										href={crumb.href}
										className={
											index === breadcrumbs.length - 1
												? "font-semibold text-foreground"
												: "text-muted-foreground hover:text-foreground transition-colors"
										}
									>
										{crumb.label}
									</Link>
									{index < breadcrumbs.length - 1 && (
										<span className="text-muted-foreground">/</span>
									)}
								</span>
							))}
						</nav>
					) : (
						<span className="text-sm font-semibold">techulus.cloud</span>
					)}
				</div>
				<div className="flex items-center gap-4">
					<span className="hidden sm:inline text-sm text-muted-foreground">
						{email}
					</span>
					<Button
						variant="ghost"
						size="icon"
						render={<Link href="/dashboard/settings" />}
					>
						<Settings className="size-4" />
					</Button>
					<Button
						variant="outline"
						size="sm"
						onClick={() => signOut().then(() => router.push("/login"))}
					>
						Sign Out
					</Button>
				</div>
			</div>
		</header>
	);
}

export function DashboardLayoutClient({
	children,
}: {
	children: React.ReactNode;
}) {
	const router = useRouter();
	const { data: session, isPending } = useSession();

	useEffect(() => {
		if (!isPending && !session) {
			router.push("/login");
		}
	}, [session, isPending, router]);

	if (isPending) {
		return (
			<div className="min-h-screen">
				<header className="border-b">
					<div className="container max-w-full mx-auto px-4 h-14 flex items-center justify-between">
						<div className="flex items-center gap-3">
							<div className="h-6 w-6 bg-zinc-200 dark:bg-zinc-700 rounded animate-pulse" />
							<div className="h-4 w-24 bg-zinc-200 dark:bg-zinc-700 rounded animate-pulse" />
						</div>
						<div className="flex items-center gap-4">
							<div className="hidden sm:block h-4 w-32 bg-zinc-200 dark:bg-zinc-700 rounded animate-pulse" />
							<div className="h-8 w-20 bg-zinc-200 dark:bg-zinc-700 rounded animate-pulse" />
						</div>
					</div>
				</header>
				<main className="container max-w-7xl mx-auto px-4 py-6">
					<div className="space-y-4">
						<div className="h-8 w-48 bg-zinc-200 dark:bg-zinc-700 rounded animate-pulse" />
						<div className="h-4 w-64 bg-zinc-200 dark:bg-zinc-700 rounded animate-pulse" />
					</div>
				</main>
			</div>
		);
	}

	if (!session) {
		return null;
	}

	return (
		<BreadcrumbDataProvider>
			<div className="min-h-screen">
				<DashboardHeader email={session.user.email} />
				<OfflineServersBanner />
				<main>{children}</main>
				<Toaster />
			</div>
		</BreadcrumbDataProvider>
	);
}
