import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";

type PageHeaderProps = {
	title: string;
	description?: string;
	backHref?: string;
	actions?: React.ReactNode;
};

export function PageHeader({
	title,
	description,
	backHref,
	actions,
}: PageHeaderProps) {
	return (
		<div className="flex items-center justify-between">
			<div className="flex items-center gap-4">
				{backHref && (
					<Link href={backHref}>
						<Button variant="ghost" size="icon">
							<ArrowLeft className="h-4 w-4" />
						</Button>
					</Link>
				)}
				<div>
					<h1 className="text-2xl font-bold">{title}</h1>
					{description && (
						<p className="text-sm text-muted-foreground">{description}</p>
					)}
				</div>
			</div>
			{actions && <div className="flex items-center gap-2">{actions}</div>}
		</div>
	);
}
