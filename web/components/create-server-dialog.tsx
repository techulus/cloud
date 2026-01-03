"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createServer } from "@/actions/servers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";

type ServerResult = {
	id: string;
	name: string;
	agentToken: string;
};

export function CreateServerDialog() {
	const router = useRouter();
	const [isOpen, setIsOpen] = useState(false);
	const [name, setName] = useState("");
	const [isLoading, setIsLoading] = useState(false);
	const [result, setResult] = useState<ServerResult | null>(null);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!name.trim()) return;

		setIsLoading(true);
		try {
			const server = await createServer(name.trim());
			setResult(server);
		} catch (error) {
			console.error("Failed to create server:", error);
		} finally {
			setIsLoading(false);
		}
	};

	const handleOpenChange = (open: boolean) => {
		setIsOpen(open);
		if (!open) {
			setName("");
			setResult(null);
		}
	};

	const handleDone = () => {
		setIsOpen(false);
		setName("");
		setResult(null);
		router.refresh();
	};

	return (
		<Dialog open={isOpen} onOpenChange={handleOpenChange}>
			<DialogTrigger render={<Button variant="outline" />}>
				Add Server
			</DialogTrigger>
			<DialogContent className="sm:max-w-lg">
				{result ? (
					<>
						<DialogHeader>
							<DialogTitle>Server Created</DialogTitle>
							<DialogDescription>
								Install the agent on your server using the token below
							</DialogDescription>
						</DialogHeader>
						<div className="space-y-4">
							<div className="space-y-2">
								<Label>Server Name</Label>
								<p className="text-sm font-medium">{result.name}</p>
							</div>
							<div className="space-y-2">
								<Label>Agent Token</Label>
								<code className="block p-3 bg-muted rounded-lg text-sm break-all font-mono">
									{result.agentToken}
								</code>
								<p className="text-xs text-muted-foreground">
									This token expires in 24 hours and can only be used once.
								</p>
							</div>
							<div className="space-y-2">
								<Label>Install Command</Label>
								<code className="block p-3 bg-muted rounded-lg text-sm break-all font-mono">
									sudo CONTROL_PLANE_URL={process.env.NEXT_PUBLIC_APP_URL}{" "}
									REGISTRATION_TOKEN={result.agentToken} bash -c &quot;$(curl
									-fsSL {process.env.NEXT_PUBLIC_APP_URL}/install.sh)&quot;
								</code>
							</div>
							<div className="flex justify-end">
								<Button onClick={handleDone}>Done</Button>
							</div>
						</div>
					</>
				) : (
					<>
						<DialogHeader>
							<DialogTitle>Add Server</DialogTitle>
							<DialogDescription>
								Register a new server to your fleet
							</DialogDescription>
						</DialogHeader>
						<form onSubmit={handleSubmit} className="space-y-4">
							<div className="space-y-2">
								<Label htmlFor="server-name">Server Name</Label>
								<Input
									id="server-name"
									value={name}
									onChange={(e) => setName(e.target.value)}
									placeholder="production-1"
									autoFocus
								/>
							</div>
							<div className="flex justify-end gap-2">
								<Button
									type="button"
									variant="outline"
									onClick={() => setIsOpen(false)}
								>
									Cancel
								</Button>
								<Button type="submit" disabled={isLoading || !name.trim()}>
									{isLoading ? "Creating..." : "Create"}
								</Button>
							</div>
						</form>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
