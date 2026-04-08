"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
import { authClient } from "@/lib/auth-client";

function normalizeUserCode(value: string) {
	return value.trim().replace(/-/g, "").toUpperCase();
}

export function DeviceAuthorizationPage() {
	const router = useRouter();
	const searchParams = useSearchParams();
	const initialUserCode = useMemo(
		() => searchParams.get("user_code") || "",
		[searchParams],
	);
	const [userCode, setUserCode] = useState(initialUserCode);
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);

	useEffect(() => {
		setUserCode(initialUserCode);
	}, [initialUserCode]);

	async function verifyCode(code: string) {
		const formatted = normalizeUserCode(code);
		if (!formatted) {
			setError("Enter the device code to continue");
			return;
		}

		setLoading(true);
		setError("");

		try {
			const response = await authClient.device({
				query: { user_code: formatted },
			});

			if (response.error || !response.data) {
				setError(response.error?.error_description || "Invalid or expired code");
				return;
			}

			router.push(`/device/approve?user_code=${encodeURIComponent(formatted)}`);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Invalid or expired code");
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		if (initialUserCode) {
			void verifyCode(initialUserCode);
		}
		// initialUserCode is intentionally the only trigger here so a shared
		// verification link can continue without another submit.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [initialUserCode]);

	return (
		<div className="min-h-screen flex items-center justify-center p-4">
			<Card className="w-full max-w-md">
				<CardHeader>
					<CardTitle>Authorize Device</CardTitle>
					<CardDescription>
						Enter the code shown in your terminal to continue signing in.
					</CardDescription>
				</CardHeader>
				<form
					onSubmit={(event) => {
						event.preventDefault();
						void verifyCode(userCode);
					}}
				>
					<CardContent className="space-y-4">
						<div className="space-y-2">
							<Label htmlFor="user-code">Device Code</Label>
							<Input
								id="user-code"
								value={userCode}
								onChange={(event) => {
									setUserCode(event.target.value);
									setError("");
								}}
								placeholder="ABCD1234"
								autoFocus
								autoComplete="one-time-code"
							/>
						</div>
						{error ? (
							<div className="text-sm text-destructive bg-destructive/10 p-3 rounded-lg">
								{error}
							</div>
						) : null}
					</CardContent>
					<CardFooter className="justify-end">
						<Button type="submit" disabled={loading}>
							{loading ? "Checking..." : "Continue"}
						</Button>
					</CardFooter>
				</form>
			</Card>
		</div>
	);
}
