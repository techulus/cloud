import {
	Book,
	Box,
	Clock,
	FileText,
	Github,
	GitBranch,
	Globe,
	HardDrive,
	Hammer,
	KeyRound,
	Layers,
	Lock,
	MapPin,
	Network,
	Plug,
	Server,
	Shield,
} from "lucide-react";
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

					<div className="flex flex-wrap items-center justify-center gap-4">
						<Link
							href="https://github.com/techulus/cloud"
							target="_blank"
							className={buttonVariants({ variant: "secondary", size: "lg" })}
						>
							<Github className="mr-2 h-5 w-5" />
							Star on GitHub
						</Link>
						<Link
							href="https://github.com/techulus/cloud/blob/main/web/SELF-HOSTING.md"
							target="_blank"
							className={buttonVariants({ variant: "outline", size: "lg" })}
						>
							<Book className="mr-2 h-5 w-5" />
							Self-Hosting Guide
						</Link>
					</div>
				</div>

				<div className="mt-24 grid gap-6 md:grid-cols-3 max-w-5xl mx-auto">
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
								<Server className="h-6 w-6 text-primary" />
							</div>
							<h3 className="text-lg font-semibold mb-2">
								Proxy & Worker Nodes
							</h3>
							<p className="text-muted-foreground text-sm">
								Separate concerns with node types. Proxy nodes handle public
								traffic and TLS. Worker nodes just run containers.
							</p>
						</CardContent>
					</Card>

					<Card className="border-0 bg-card/50 backdrop-blur">
						<CardContent>
							<div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
								<Server className="h-6 w-6 text-primary" />
							</div>
							<h3 className="text-lg font-semibold mb-2">
								Your Infrastructure, Your Way
							</h3>
							<p className="text-muted-foreground text-sm">
								If it runs in a container, it runs here—on your metal, cloud
								VMs, or that Raspberry Pi. Scale as you grow. Your data, your
								rules, no lock-in.
							</p>
						</CardContent>
					</Card>

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
								<HardDrive className="h-6 w-6 text-primary" />
							</div>
							<h3 className="text-lg font-semibold mb-2">Persistent Volumes</h3>
							<p className="text-muted-foreground text-sm">
								Named volumes that survive container restarts. Your data stays
								put.
							</p>
						</CardContent>
					</Card>

					<Card className="border-0 bg-card/50 backdrop-blur">
						<CardContent>
							<div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
								<HardDrive className="h-6 w-6 text-primary" />
							</div>
							<h3 className="text-lg font-semibold mb-2">Scheduled Backups</h3>
							<p className="text-muted-foreground text-sm">
								Automatic and manual backups to S3-compatible storage. Set it
								and forget it.
							</p>
						</CardContent>
					</Card>

					<Card className="border-0 bg-card/50 backdrop-blur">
						<CardContent>
							<div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
								<Shield className="h-6 w-6 text-primary" />
							</div>
							<h3 className="text-lg font-semibold mb-2">WireGuard Mesh</h3>
							<p className="text-muted-foreground text-sm">
								All server-to-server traffic encrypted via WireGuard. Your
								containers communicate over a private mesh network.
							</p>
						</CardContent>
					</Card>

					<Card className="border-0 bg-card/50 backdrop-blur">
						<CardContent>
							<div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
								<Network className="h-6 w-6 text-primary" />
							</div>
							<h3 className="text-lg font-semibold mb-2">Service Discovery</h3>
							<p className="text-muted-foreground text-sm">
								Services find each other via .internal domains. No hardcoded
								IPs, no service mesh complexity. Just DNS that works.
							</p>
						</CardContent>
					</Card>

					<Card className="border-0 bg-card/50 backdrop-blur">
						<CardContent>
							<div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
								<Globe className="h-6 w-6 text-primary" />
							</div>
							<h3 className="text-lg font-semibold mb-2">Automatic HTTPS</h3>
							<p className="text-muted-foreground text-sm">
								TLS certificates handled automatically. Point your domain, get
								HTTPS. No manual certificate management.
							</p>
						</CardContent>
					</Card>

					<Card className="border-0 bg-card/50 backdrop-blur">
						<CardContent>
							<div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
								<Plug className="h-6 w-6 text-primary" />
							</div>
							<h3 className="text-lg font-semibold mb-2">TCP/UDP Proxy</h3>
							<p className="text-muted-foreground text-sm">
								Not everything speaks HTTP. Expose databases, game servers,
								whatever you need.
							</p>
						</CardContent>
					</Card>

					<Card className="border-0 bg-card/50 backdrop-blur">
						<CardContent>
							<div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
								<MapPin className="h-6 w-6 text-primary" />
							</div>
							<h3 className="text-lg font-semibold mb-2">GeoDNS</h3>
							<p className="text-muted-foreground text-sm">
								Route users to the nearest proxy. Automatic failover when things
								go wrong.
							</p>
						</CardContent>
					</Card>

					<Card className="border-0 bg-card/50 backdrop-blur">
						<CardContent>
							<div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
								<GitBranch className="h-6 w-6 text-primary" />
							</div>
							<h3 className="text-lg font-semibold mb-2">GitHub Auto-Deploy</h3>
							<p className="text-muted-foreground text-sm">
								Push to your branch, watch it deploy. Connect your GitHub repo
								and get automatic builds and deployments on every commit.
							</p>
						</CardContent>
					</Card>

					<Card className="border-0 bg-card/50 backdrop-blur">
						<CardContent>
							<div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
								<Hammer className="h-6 w-6 text-primary" />
							</div>
							<h3 className="text-lg font-semibold mb-2">Build from Source</h3>
							<p className="text-muted-foreground text-sm">
								Push code, we build it. Railpack or your own Dockerfile—your
								choice.
							</p>
						</CardContent>
					</Card>

					<Card className="border-0 bg-card/50 backdrop-blur">
						<CardContent>
							<div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
								<Clock className="h-6 w-6 text-primary" />
							</div>
							<h3 className="text-lg font-semibold mb-2">
								Scheduled Deployments
							</h3>
							<p className="text-muted-foreground text-sm">
								Cron-based deployments. Redeploy on a schedule without lifting a
								finger.
							</p>
						</CardContent>
					</Card>

					<Card className="border-0 bg-card/50 backdrop-blur">
						<CardContent>
							<div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
								<Layers className="h-6 w-6 text-primary" />
							</div>
							<h3 className="text-lg font-semibold mb-2">Multi-Environment</h3>
							<p className="text-muted-foreground text-sm">
								Production, staging, dev—all in one project. Deploy the same
								service differently.
							</p>
						</CardContent>
					</Card>

					<Card className="border-0 bg-card/50 backdrop-blur">
						<CardContent>
							<div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
								<Lock className="h-6 w-6 text-primary" />
							</div>
							<h3 className="text-lg font-semibold mb-2">Private by Default</h3>
							<p className="text-muted-foreground text-sm">
								Your services talk to each other privately. Nothing gets exposed
								unless you say so. Public traffic only through proxy nodes.
							</p>
						</CardContent>
					</Card>

					<Card className="border-0 bg-card/50 backdrop-blur">
						<CardContent>
							<div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
								<KeyRound className="h-6 w-6 text-primary" />
							</div>
							<h3 className="text-lg font-semibold mb-2">Environment Secrets</h3>
							<p className="text-muted-foreground text-sm">
								Inject secrets at runtime. Never bake credentials into your
								images.
							</p>
						</CardContent>
					</Card>

					<Card className="border-0 bg-card/50 backdrop-blur">
						<CardContent>
							<div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
								<FileText className="h-6 w-6 text-primary" />
							</div>
							<h3 className="text-lg font-semibold mb-2">Logs & Monitoring</h3>
							<p className="text-muted-foreground text-sm">
								Stream logs from containers, builds, and requests. All in one
								place.
							</p>
						</CardContent>
					</Card>
				</div>
			</div>
		</div>
	);
}
