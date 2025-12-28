import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

type Breadcrumb = {
	label: string;
	href?: string;
};

type PageHeaderProps = {
	title: string;
	description?: string;
	breadcrumbs?: Breadcrumb[];
	actions?: React.ReactNode;
};

export function PageHeader({
	title,
	description,
	breadcrumbs,
	actions,
}: PageHeaderProps) {
	return (
		<div className="flex items-center justify-between h-10">
			<div className="flex items-center gap-2">
				{breadcrumbs && breadcrumbs.length > 0 && (
					<nav className="flex items-center gap-1 text-sm">
						{breadcrumbs.map((crumb, i) => (
							<span key={i} className="flex items-center gap-1">
								{crumb.href ? (
									<Link
										href={crumb.href}
										className="text-muted-foreground hover:text-foreground transition-colors"
									>
										{crumb.label}
									</Link>
								) : (
									<span className="text-muted-foreground">{crumb.label}</span>
								)}
								<ChevronRight className="h-4 w-4 text-muted-foreground" />
							</span>
						))}
					</nav>
				)}
				<div>
					<h1 className="text-base font-bold">{title}</h1>
					{description && (
						<p className="text-sm text-muted-foreground">{description}</p>
					)}
				</div>
			</div>
			{actions && <div className="flex items-center gap-2">{actions}</div>}
		</div>
	);
}
