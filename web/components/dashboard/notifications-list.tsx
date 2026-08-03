"use client";

import { Bell, Check, CircleAlert } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { mutate as mutateGlobal } from "swr";
import useSWRInfinite from "swr/infinite";
import { Button } from "@/components/ui/button";
import {
	Empty,
	EmptyDescription,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { formatDateTime, formatRelativeTime } from "@/lib/date";
import { fetcher } from "@/lib/fetcher";
import { cn } from "@/lib/utils";

type NotificationItem = {
	id: string;
	kind: string;
	title: string;
	body: string;
	href: string | null;
	readAt: string | null;
	createdAt: string;
};

type NotificationPage = {
	notifications: NotificationItem[];
	unreadCount: number;
	nextCursor: string | null;
};

export function NotificationsList() {
	const [mutating, setMutating] = useState<string | null>(null);
	const { data, error, isLoading, isValidating, mutate, size, setSize } =
		useSWRInfinite<NotificationPage>((index, previous) => {
			if (previous && !previous.nextCursor) return null;
			return index === 0
				? "/api/notifications"
				: `/api/notifications?cursor=${encodeURIComponent(previous?.nextCursor ?? "")}`;
		}, fetcher);
	const items = useMemo(
		() => data?.flatMap((page) => page.notifications) ?? [],
		[data],
	);
	const unreadCount = data?.[0]?.unreadCount ?? 0;
	const hasMore = data?.at(-1)?.nextCursor != null;

	async function markRead(id?: string) {
		setMutating(id ?? "all");
		try {
			const response = await fetch("/api/notifications/read", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(id ? { id } : { markAll: true }),
				keepalive: true,
			});
			if (!response.ok) throw new Error("Unable to update notifications");
			await Promise.all([mutate(), mutateGlobal("/api/notifications")]);
		} finally {
			setMutating(null);
		}
	}

	if (isLoading) {
		return (
			<div className="flex justify-center py-16">
				<Spinner />
			</div>
		);
	}
	if (error) {
		return (
			<Empty className="border py-12">
				<EmptyMedia variant="icon">
					<CircleAlert />
				</EmptyMedia>
				<EmptyTitle>Unable to load notifications</EmptyTitle>
				<EmptyDescription>
					Notifications could not be loaded. Try again.
				</EmptyDescription>
				<Button variant="outline" onClick={() => void mutate()}>
					Retry
				</Button>
			</Empty>
		);
	}
	if (items.length === 0) {
		return (
			<Empty className="border py-12">
				<EmptyMedia variant="icon">
					<Bell />
				</EmptyMedia>
				<EmptyTitle>No notifications</EmptyTitle>
				<EmptyDescription>
					Operational alerts will appear here.
				</EmptyDescription>
			</Empty>
		);
	}

	return (
		<div className="space-y-3">
			<div className="flex justify-end">
				<Button
					variant="outline"
					size="sm"
					disabled={!unreadCount || mutating !== null}
					onClick={() => void markRead()}
				>
					{mutating === "all" ? <Spinner /> : null} Mark all as read
				</Button>
			</div>
			<div className="overflow-hidden rounded-lg border">
				{items.map((item) => (
					<article
						key={item.id}
						className={cn(
							"flex gap-2.5 border-b px-3 py-2.5 last:border-0",
							!item.readAt && "bg-primary/5",
						)}
					>
						<span
							className={cn(
								"mt-2 size-2 shrink-0 rounded-full",
								item.readAt ? "bg-muted" : "bg-primary",
							)}
						/>
						<div className="min-w-0 flex-1 space-y-0.5">
							{item.href ? (
								<Link
									href={item.href}
									onClick={() => !item.readAt && void markRead(item.id)}
									className="text-sm font-medium hover:underline"
								>
									{item.title}
								</Link>
							) : (
								<p className="text-sm font-medium">{item.title}</p>
							)}
							<p className="text-sm text-muted-foreground">{item.body}</p>
							<time
								className="block text-xs text-muted-foreground"
								dateTime={item.createdAt}
								title={formatDateTime(item.createdAt)}
							>
								{formatRelativeTime(item.createdAt)}
							</time>
						</div>
						{!item.readAt && (
							<Button
								size="icon-sm"
								variant="outline"
								className="self-center"
								disabled={mutating !== null}
								onClick={() => void markRead(item.id)}
								aria-label="Mark notification as read"
								title="Mark as read"
							>
								{mutating === item.id ? <Spinner /> : <Check />}
							</Button>
						)}
					</article>
				))}
			</div>
			{hasMore && (
				<div className="flex justify-center">
					<Button
						variant="outline"
						size="sm"
						disabled={isValidating}
						onClick={() => void setSize(size + 1)}
					>
						{isValidating ? <Spinner /> : null} Load older
					</Button>
				</div>
			)}
		</div>
	);
}
