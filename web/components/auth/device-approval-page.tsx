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
import { Spinner } from "@/components/ui/spinner";
import { authClient, useSession } from "@/lib/auth-client";

export function DeviceApprovalPage() {
	const router = useRouter();
	const searchParams = useSearchParams();
	const { data: session, isPending } = useSession();
	const userCode = useMemo(
		() => searchParams.get("user_code") || searchParams.get("userCode") || "",
		[searchParams],
	);
	const [isProcessing, setIsProcessing] = useState(false);
	const [error, setError] = useState("");
	const [successMessage, setSuccessMessage] = useState("");

	useEffect(() => {
		if (isPending || session || !userCode) {
			return;
		}

		router.replace(`/?redirect=${encodeURIComponent(`/device/approve?user_code=${userCode}`)}`);
	}, [isPending, router, session, userCode]);

	async function handleDecision(type: "approve" | "deny") {
		if (!userCode) {
			setError("Missing device code");
			return;
		}

		setIsProcessing(true);
		setError("");
		setSuccessMessage("");

		try {
			if (type === "approve") {
				await authClient.device.approve({
					userCode,
				});
				setSuccessMessage("Device approved. You can return to the terminal.");
			} else {
				await authClient.device.deny({
					userCode,
				});
				setSuccessMessage("Device denied. You can close this page.");
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to update device request");
		} finally {
			setIsProcessing(false);
		}
	}

	if (isPending) {
		return (
			<div className="min-h-screen flex items-center justify-center">
				<Spinner className="size-6" />
			</div>
		);
	}

	return (
		<div className="min-h-screen flex items-center justify-center p-4">
			<Card className="w-full max-w-md">
				<CardHeader>
					<CardTitle>Device Authorization Request</CardTitle>
					<CardDescription>
						Review the pending terminal sign-in request for your account.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="rounded-lg border bg-muted/40 p-4">
						<p className="text-sm text-muted-foreground">Code</p>
						<p className="font-mono text-lg">{userCode || "Unavailable"}</p>
					</div>
					{error ? (
						<div className="text-sm text-destructive bg-destructive/10 p-3 rounded-lg">
							{error}
						</div>
					) : null}
					{successMessage ? (
						<div className="text-sm text-emerald-700 bg-emerald-500/10 p-3 rounded-lg">
							{successMessage}
						</div>
					) : null}
				</CardContent>
				<CardFooter className="flex justify-end gap-2">
					<Button
						type="button"
						variant="outline"
						onClick={() => void handleDecision("deny")}
						disabled={isProcessing || !!successMessage}
					>
						Deny
					</Button>
					<Button
						type="button"
						onClick={() => void handleDecision("approve")}
						disabled={isProcessing || !!successMessage}
					>
						{isProcessing ? "Processing..." : "Approve"}
					</Button>
				</CardFooter>
			</Card>
		</div>
	);
}
