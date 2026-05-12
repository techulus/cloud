import { cn } from "@/lib/utils";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="skeleton"
			className={cn(
				"relative overflow-hidden rounded-md bg-muted before:absolute before:inset-y-0 before:-left-1/2 before:w-1/2 before:animate-shimmer before:bg-gradient-to-r before:from-transparent before:via-background/80 before:to-transparent",
				className,
			)}
			{...props}
		/>
	);
}

export { Skeleton };
