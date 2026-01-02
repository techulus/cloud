"use client";

import { useEffect, type ReactNode } from "react";
import { useBreadcrumbs } from "@/components/core/breadcrumb-context";

type Breadcrumb = {
	label: string;
	href?: string;
};

export function PageHeader({
	breadcrumbs,
	title,
	actions,
}: {
	breadcrumbs: Breadcrumb[];
	title: string;
	actions?: ReactNode;
}) {
	const { setBreadcrumbs, clearBreadcrumbs } = useBreadcrumbs();

	useEffect(() => {
		setBreadcrumbs(
			breadcrumbs,
			<div className="flex items-center gap-3">
				<span className="text-sm font-semibold">{title}</span>
				{actions}
			</div>,
		);
		return () => clearBreadcrumbs();
	}, [title, actions, breadcrumbs, setBreadcrumbs, clearBreadcrumbs]);

	return null;
}
