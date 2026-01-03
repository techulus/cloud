"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo } from "react";
import {
	BreadcrumbDataProvider,
	useBreadcrumbData,
	type BreadcrumbKey,
} from "@/components/core/breadcrumb-data";
import { OfflineServersBanner } from "@/components/offline-servers-banner";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { Spinner } from "@/components/ui/spinner";
import { signOut, useSession } from "@/lib/auth-client";

type Breadcrumb = { label: string; href: string };

const BREADCRUMB_RULES: Array<{
	parent: string;
	key: BreadcrumbKey;
	format?: (value: string) => string;
}> = [
	{ parent: "projects", key: "project" },
	{ parent: "services", key: "service" },
	{ parent: "servers", key: "server" },
	{
		parent: "builds",
		key: "build",
		format: (value) => `Build ${value.slice(0, 7)}`,
	},
];

function generateBreadcrumbs(
	pathname: string,
	data: ReturnType<typeof useBreadcrumbData>,
): Breadcrumb[] {
	const segments = pathname.split("/").filter(Boolean);
	const crumbs: Breadcrumb[] = [];
	let href = "";

	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		const prev = segments[i - 1];
		href += `/${seg}`;

		if (!prev) continue;

		const rule = BREADCRUMB_RULES.find(({ parent }) => parent === prev);
		if (!rule) continue;

		const rawLabel = data[rule.key] ?? seg;
		const label = rule.format ? rule.format(rawLabel) : rawLabel;

		crumbs.push({ label, href });
	}

	return crumbs;
}

function DashboardHeader({ email }: { email: string }) {
	const router = useRouter();
	const pathname = usePathname();
	const data = useBreadcrumbData();
	const breadcrumbs = useMemo(
		() => generateBreadcrumbs(pathname, data),
		[pathname, data],
	);

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
			<div className="min-h-screen flex items-center justify-center">
				<Spinner />
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
				<main className="container max-w-7xl mx-auto px-4 py-6">
					{children}
				</main>
				<Toaster />
			</div>
		</BreadcrumbDataProvider>
	);
}
