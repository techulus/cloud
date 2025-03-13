import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";

export default function Servers() {
	return (
		<div className="flex w-full flex-wrap items-end justify-between gap-4 border-b border-zinc-950/10 pb-6 dark:border-white/10">
			<Heading>Servers</Heading>
			<div className="flex gap-4">
				<Button>Add Server</Button>
			</div>
		</div>
	);
}
