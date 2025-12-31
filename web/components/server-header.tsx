"use client";

import { useEffect, type ReactNode } from "react";
import { useBreadcrumbs } from "@/components/breadcrumb-context";

export function ServerHeader({
	serverName,
	actions,
}: {
	serverName: string;
	actions?: ReactNode;
}) {
	const { setBreadcrumbs, clearBreadcrumbs } = useBreadcrumbs();

	useEffect(() => {
		setBreadcrumbs(
			[{ label: "Servers", href: "/dashboard" }],
			<div className="flex items-center gap-3">
				<span className="text-sm font-semibold">{serverName}</span>
				{actions}
			</div>
		);
		return () => clearBreadcrumbs();
	}, [serverName, actions]);

	return null;
}
