import { cn } from "@/lib/utils";

function ButtonGroup({
	className,
	...props
}: React.ComponentProps<"div">) {
	return (
		<div
			role="group"
			data-slot="button-group"
			className={cn(
				"has-[>[data-slot=button-group]]:gap-2 has-[select[aria-hidden=true]:last-child]:[&>[data-slot=select-trigger]:last-of-type]:rounded-r-lg flex w-fit items-stretch [&>*]:focus-visible:z-10 [&>*]:focus-visible:relative [&>[data-slot=select-trigger]:not([class*='w-'])]:w-fit [&>input]:flex-1 [&>[data-slot]:not(:has(~[data-slot]))]:rounded-r-lg! [&>[data-slot]~[data-slot]]:rounded-l-none [&>[data-slot]~[data-slot]]:border-l-0 [&>[data-slot]]:rounded-r-none",
				className,
			)}
			{...props}
		/>
	);
}

export { ButtonGroup };
