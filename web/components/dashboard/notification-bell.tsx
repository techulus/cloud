"use client";

import { Bell } from "lucide-react";
import Link from "next/link";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { fetcher } from "@/lib/fetcher";

type NotificationSummary = { unreadCount: number };

export function NotificationBell() {
	const { data } = useSWR<NotificationSummary>("/api/notifications", fetcher, {
		refreshInterval: 30_000,
		revalidateOnFocus: true,
	});
	const unreadCount = data?.unreadCount ?? 0;

	return (
		<Button
			variant="ghost"
			size="icon"
			nativeButton={false}
			className="relative"
			render={<Link href="/dashboard/notifications" />}
			aria-label={
				unreadCount > 0
					? `Notifications, ${unreadCount} unread`
					: "Notifications"
			}
		>
			<Bell />
			{unreadCount > 0 && (
				<span className="absolute -top-1 -right-1 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] leading-4 text-white">
					{unreadCount > 99 ? "99+" : unreadCount}
				</span>
			)}
		</Button>
	);
}
