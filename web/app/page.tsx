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
						Run your containers without the headache. Fast, reliable, and you're
						in control.
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
						<CardContent>
							<div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
								<Box className="h-6 w-6 text-primary" />
							</div>
							<h3 className="text-lg font-semibold mb-2">
								Stateless or Stateful
							</h3>
							<p className="text-muted-foreground text-sm">
								Containers come and go, that's the point. But when you need data
								to stick around, volumes have you covered.
							</p>
						</CardContent>
					</Card>

					<Card className="border-0 bg-card/50 backdrop-blur">
						<CardContent>
							<div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
								<Server className="h-6 w-6 text-primary" />
							</div>
							<h3 className="text-lg font-semibold mb-2">Machines are Peers</h3>
							<p className="text-muted-foreground text-sm">
								No master nodes, no single points of failure. Every machine
								pulls its weight equally. One goes down? The others pick up the
								slack.
							</p>
						</CardContent>
					</Card>

					<Card className="border-0 bg-card/50 backdrop-blur">
						<CardContent>
							<div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
								<Network className="h-6 w-6 text-primary" />
							</div>
							<h3 className="text-lg font-semibold mb-2">Private by Default</h3>
							<p className="text-muted-foreground text-sm">
								Your services talk to each other privately. Nothing gets exposed
								unless you say so.
							</p>
						</CardContent>
					</Card>
				</div>
			</div>
		</div>
	);
}
