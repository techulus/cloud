"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { signIn, useSession } from "@/lib/auth-client";

export function SignInPageSkeleton() {
	return (
		<div className="min-h-screen bg-background">
			<div
				aria-hidden="true"
				className="mx-auto flex min-h-screen w-full max-w-md items-center px-6"
			>
				<div className="w-full space-y-6">
					<div className="flex items-center gap-3">
						<Skeleton className="size-10 rounded-lg" />
						<div className="space-y-2">
							<Skeleton className="h-4 w-36" />
							<Skeleton className="h-3 w-24" />
						</div>
					</div>

					<div className="space-y-3">
						<Skeleton className="h-10 w-full rounded-lg" />
						<Skeleton className="h-10 w-full rounded-lg" />
						<Skeleton className="h-10 w-2/3 rounded-lg" />
					</div>
				</div>
			</div>
			<div aria-live="polite" className="sr-only">
				Loading
			</div>
		</div>
	);
}

export function SignInPage() {
	const router = useRouter();
	const searchParams = useSearchParams();
	const { data: session, isPending } = useSession();
	const redirectTo = searchParams.get("redirect") || "/dashboard";

	useEffect(() => {
		if (!isPending && session) {
			router.push(redirectTo);
		}
	}, [session, isPending, redirectTo, router]);

	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		setError("");
		setLoading(true);

		const { error } = await signIn.email({
			email,
			password,
		});

		setLoading(false);

		if (error) {
			setError(error.message || "Failed to sign in");
			return;
		}

		router.push(redirectTo);
	}

	if (isPending || session) {
		return <SignInPageSkeleton />;
	}

	return (
		<div className="min-h-screen flex flex-col items-center justify-center p-4">
			<Image
				src="/logo.png"
				alt="Logo"
				width={48}
				height={48}
				className="mb-6"
			/>
			<Card className="w-full max-w-md">
				<CardHeader>
					<CardTitle>Sign In</CardTitle>
					<CardDescription>
						Enter your credentials to access your account
					</CardDescription>
				</CardHeader>
				<form onSubmit={handleSubmit}>
					<CardContent className="space-y-4 pb-4">
						{error && (
							<div className="text-sm text-destructive bg-destructive/10 p-3 rounded-lg">
								{error}
							</div>
						)}
						<div className="space-y-2">
							<Label htmlFor="email">Email</Label>
							<Input
								id="email"
								type="email"
								placeholder="you@example.com"
								value={email}
								onChange={(e) => setEmail(e.target.value)}
								required
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="password">Password</Label>
							<Input
								id="password"
								type="password"
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								required
							/>
						</div>
					</CardContent>
					<CardFooter className="flex-col gap-4">
						<Button type="submit" className="w-full" disabled={loading}>
							{loading ? "Signing in..." : "Sign In"}
						</Button>
						<p className="text-sm text-muted-foreground">
							Don&apos;t have an account?{" "}
							<Link
								href={
									redirectTo === "/dashboard"
										? "/register"
										: `/register?redirect=${encodeURIComponent(redirectTo)}`
								}
								className="text-primary hover:underline"
							>
								Sign up
							</Link>
						</p>
					</CardFooter>
				</form>
			</Card>
		</div>
	);
}
