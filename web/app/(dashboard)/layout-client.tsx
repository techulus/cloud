"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { signOut, useSession } from "@/lib/auth-client";

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
		<div className="min-h-screen">
			<header className="border-b">
				<div className="container max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
					<Link href="/dashboard" className="flex items-center gap-2 text-sm">
						<Image
							src="/logo.png"
							alt="Techulus Cloud"
							className="h-6"
							width={24}
							height={24}
						/>
						<p>
							<span className="font-semibold">techulus</span>.cloud{" "}
						</p>
					</Link>
					<div className="flex items-center gap-4">
						<span className="text-sm text-muted-foreground">
							{session.user.email}
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
			<main className="container max-w-7xl mx-auto px-4 py-6">{children}</main>
		</div>
	);
}
