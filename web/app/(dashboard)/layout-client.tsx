"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { LogOut, Settings, User } from "lucide-react";
import {
	BreadcrumbDataProvider,
	useBreadcrumbs,
} from "@/components/core/breadcrumb-data";
import { OfflineServersBanner } from "@/components/server/offline-servers-banner";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Toaster } from "@/components/ui/sonner";
import { signOut, useSession } from "@/lib/auth-client";

function DashboardHeader({ email }: { email: string }) {
	const router = useRouter();
	const breadcrumbs = useBreadcrumbs();

	const mobileBreadcrumbs =
		breadcrumbs.length > 2 ? breadcrumbs.slice(-2) : breadcrumbs;
	const showEllipsis = breadcrumbs.length > 2;

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
						<>
							<nav className="hidden sm:flex items-center gap-2 text-sm">
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
							<nav className="flex sm:hidden items-center gap-2 text-sm">
								{showEllipsis && (
									<>
										<span className="text-muted-foreground">...</span>
										<span className="text-muted-foreground">/</span>
									</>
								)}
								{mobileBreadcrumbs.map((crumb, index) => (
									<span key={crumb.href} className="flex items-center gap-2">
										<Link
											href={crumb.href}
											className={
												index === mobileBreadcrumbs.length - 1
													? "font-semibold text-foreground"
													: "text-muted-foreground hover:text-foreground transition-colors"
											}
										>
											{crumb.label}
										</Link>
										{index < mobileBreadcrumbs.length - 1 && (
											<span className="text-muted-foreground">/</span>
										)}
									</span>
								))}
							</nav>
						</>
					) : (
						<span className="text-sm font-semibold">techulus.cloud</span>
					)}
				</div>
				<DropdownMenu>
					<DropdownMenuTrigger
						className="flex items-center rounded-md p-2 hover:bg-accent transition-colors cursor-pointer"
						render={<button type="button" />}
					>
						<User className="size-4" />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" sideOffset={8}>
						<DropdownMenuGroup>
							<DropdownMenuLabel>{email}</DropdownMenuLabel>
						</DropdownMenuGroup>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							render={<Link href="/dashboard/settings" />}
							className="cursor-pointer"
						>
							<Settings className="size-4" />
							Settings
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							variant="destructive"
							onClick={() => signOut().then(() => router.push("/"))}
							className="cursor-pointer"
						>
							<LogOut className="size-4" />
							Sign Out
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
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
			router.push("/");
		}
	}, [session, isPending, router]);

	if (isPending) {
		return (
			<div className="min-h-screen">
				<header className="border-b">
					<div className="container max-w-full mx-auto px-4 h-14 flex items-center justify-between">
						<div className="flex items-center gap-3">
							<div className="h-6 w-6 bg-slate-200 dark:bg-slate-700 rounded animate-pulse" />
							<div className="h-4 w-24 bg-slate-200 dark:bg-slate-700 rounded animate-pulse" />
						</div>
						<div className="flex items-center gap-4">
							<div className="hidden sm:block h-4 w-32 bg-slate-200 dark:bg-slate-700 rounded animate-pulse" />
							<div className="h-8 w-20 bg-slate-200 dark:bg-slate-700 rounded animate-pulse" />
						</div>
					</div>
				</header>
				<main className="container max-w-7xl mx-auto px-4 py-6">
					<div className="space-y-4">
						<div className="h-8 w-48 bg-slate-200 dark:bg-slate-700 rounded animate-pulse" />
						<div className="h-4 w-64 bg-slate-200 dark:bg-slate-700 rounded animate-pulse" />
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
