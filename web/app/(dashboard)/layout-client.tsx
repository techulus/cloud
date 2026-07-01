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
import { DashboardPageSkeleton } from "@/components/dashboard/dashboard-page-skeleton";
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

function DashboardHeader({
	email,
	name,
}: {
	email: string;
	name: string;
}) {
	const router = useRouter();
	const breadcrumbs = useBreadcrumbs();
	const getBreadcrumbKey = (
		crumb: (typeof breadcrumbs)[number],
		index: number,
	) => `${crumb.href}:${crumb.label}:${index}`;

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
									<span
										key={getBreadcrumbKey(crumb, index)}
										className="flex items-center gap-2"
									>
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
									<span
										key={getBreadcrumbKey(crumb, index)}
										className="flex items-center gap-2"
									>
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
							<DropdownMenuLabel>
								<span className="block font-medium">{name}</span>
								<span className="block truncate text-xs font-normal text-muted-foreground">
									{email}
								</span>
							</DropdownMenuLabel>
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
		return <DashboardPageSkeleton />;
	}

	if (!session) {
		return null;
	}

	return (
		<BreadcrumbDataProvider>
			<div className="min-h-screen">
				<DashboardHeader
					email={session.user.email}
					name={session.user.name}
				/>
				<OfflineServersBanner />
				<main>{children}</main>
				<Toaster />
			</div>
		</BreadcrumbDataProvider>
	);
}
