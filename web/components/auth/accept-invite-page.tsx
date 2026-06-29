"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import { useState } from "react";
import { acceptInvite } from "@/actions/members";
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
import type { InvitableMemberRole } from "@/db/types";

type Props = {
	token: string;
	email: string;
	role: InvitableMemberRole;
};

export function AcceptInvitePage({ token, email, role }: Props) {
	const router = useRouter();
	const [name, setName] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);

	async function handleSubmit(event: FormEvent) {
		event.preventDefault();
		setError("");
		setLoading(true);

		try {
			await acceptInvite({ token, name, password });
			router.push("/?redirect=/dashboard");
		} catch (error) {
			setError(
				error instanceof Error ? error.message : "Failed to accept invitation",
			);
		} finally {
			setLoading(false);
		}
	}

	return (
		<div className="min-h-screen flex items-center justify-center p-4">
			<Card className="w-full max-w-md">
				<CardHeader>
					<CardTitle>Accept Invitation</CardTitle>
					<CardDescription>
						Create your account for {email} as a {role}
					</CardDescription>
				</CardHeader>
				<form onSubmit={(event) => void handleSubmit(event)}>
					<CardContent className="space-y-4 pb-4">
						{error && (
							<div className="text-sm text-destructive bg-destructive/10 p-3 rounded-lg">
								{error}
							</div>
						)}
						<div className="space-y-2">
							<Label htmlFor="name">Name</Label>
							<Input
								id="name"
								type="text"
								value={name}
								onChange={(event) => setName(event.target.value)}
								required
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="password">Password</Label>
							<Input
								id="password"
								type="password"
								value={password}
								onChange={(event) => setPassword(event.target.value)}
								required
								minLength={8}
							/>
						</div>
					</CardContent>
					<CardFooter className="flex-col gap-4">
						<Button type="submit" className="w-full" disabled={loading}>
							{loading ? "Creating account..." : "Create Account"}
						</Button>
						<p className="text-sm text-muted-foreground">
							Already have an account?{" "}
							<Link href="/" className="text-primary hover:underline">
								Sign in
							</Link>
						</p>
					</CardFooter>
				</form>
			</Card>
		</div>
	);
}
