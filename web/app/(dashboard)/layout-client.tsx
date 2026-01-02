"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import {
	BreadcrumbProvider,
	useBreadcrumbs,
} from "@/components/breadcrumb-context";
import { OfflineServersBanner } from "@/components/offline-servers-banner";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { Spinner } from "@/components/ui/spinner";
import { signOut, useSession } from "@/lib/auth-client";

function DashboardHeader({ email }: { email: string }) {
	const router = useRouter();
	const { breadcrumbs, title } = useBreadcrumbs();

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
					{breadcrumbs.length > 0 && (
						<>
							<nav className="flex items-center gap-2 text-sm">
								{breadcrumbs.map((crumb, index) => (
									<span
										key={crumb.href || `crumb-${index}`}
										className="flex items-center gap-2"
									>
										{crumb.href ? (
											<Link
												href={crumb.href}
												className="text-muted-foreground hover:text-foreground transition-colors"
											>
												{crumb.label}
											</Link>
										) : (
											<span className="text-muted-foreground">
												{crumb.label}
											</span>
										)}
										<span className="text-muted-foreground">/</span>
									</span>
								))}
							</nav>
							{title && <span className="text-sm font-semibold">{title}</span>}
						</>
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
		<BreadcrumbProvider>
			<div className="min-h-screen">
				<DashboardHeader email={session.user.email} />
				<OfflineServersBanner />
				<main className="container max-w-7xl mx-auto px-4 py-6">
					{children}
				</main>
				<Toaster />
			</div>
		</BreadcrumbProvider>
	);
}
