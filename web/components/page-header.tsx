import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

type PageHeaderProps = {
	title: string;
	description?: string;
	backHref?: string;
	actions?: React.ReactNode;
	compact?: boolean;
};

export function PageHeader({
	title,
	description,
	backHref,
	actions,
	compact = false,
}: PageHeaderProps) {
	return (
		<div className={cn("flex items-center justify-between h-10", compact && "h-2.5")}>
			<div className="flex items-center gap-2">
				{backHref && (
					<Link href={backHref}>
						<Button variant="ghost" size="icon" className="h-8 w-8">
							<ArrowLeft className="h-4 w-4" />
						</Button>
					</Link>
				)}
				<div>
					<h1 className="text-xl font-bold">{title}</h1>
					{description && (
						<p className="text-sm text-muted-foreground">{description}</p>
					)}
				</div>
			</div>
			{actions && <div className="flex items-center gap-2">{actions}</div>}
		</div>
	);
}
