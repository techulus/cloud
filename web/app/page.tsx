import { Box, Github, Network, Server } from "lucide-react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export default function Page() {
	return (
		<div className="min-h-screen from-background to-muted/20">
			<div className="container mx-auto px-4 py-16 md:py-24">
				<div className="flex flex-col items-center text-center space-y-8 max-w-4xl mx-auto">
					<h1 className="text-4xl md:text-7xl font-bold tracking-tight py-12">
						Simple, Scalable
						<br />
						<span className="text-primary">Container Deployment</span>
					</h1>

					<p className="text-lg md:text-xl text-muted-foreground max-w-2xl">
						A seamless way to run and manage your containers. Built for speed,
						reliability, and control.
					</p>

					<Link
						href="https://github.com/techulus/cloud"
						target="_blank"
						className={buttonVariants({ variant: "secondary", size: "lg" })}
					>
						<Github className="mr-2 h-5 w-5" />
						View on GitHub
					</Link>
				</div>

				<div className="mt-24 grid gap-6 md:grid-cols-3 max-w-5xl mx-auto">
					<Card className="border-0 bg-card/50 backdrop-blur">
						<CardContent className="pt-6">
							<div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
								<Box className="h-6 w-6 text-primary" />
							</div>
							<h3 className="text-lg font-semibold mb-2">
								Workloads are Disposable
							</h3>
							<p className="text-muted-foreground text-sm">
								Containers are ephemeral by design. Scale up, scale down, or
								replace instances without state concerns. Your apps stay
								resilient through any change.
							</p>
						</CardContent>
					</Card>

					<Card className="border-0 bg-card/50 backdrop-blur">
						<CardContent className="pt-6">
							<div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
								<Server className="h-6 w-6 text-primary" />
							</div>
							<h3 className="text-lg font-semibold mb-2">Machines are Peers</h3>
							<p className="text-muted-foreground text-sm">
								No master nodes, no single points of failure. Every machine in
								the cluster is equal, enabling true horizontal scaling and
								automatic failover.
							</p>
						</CardContent>
					</Card>

					<Card className="border-0 bg-card/50 backdrop-blur">
						<CardContent className="pt-6">
							<div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
								<Network className="h-6 w-6 text-primary" />
							</div>
							<h3 className="text-lg font-semibold mb-2">
								Private-First Networking
							</h3>
							<p className="text-muted-foreground text-sm">
								Networking is private by default, exposure is deliberate.
								Services communicate securely within your mesh. You control
								exactly what reaches the outside world.
							</p>
						</CardContent>
					</Card>
				</div>
			</div>
		</div>
	);
}
