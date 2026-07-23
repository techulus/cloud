"use client";

import { REGEXP_ONLY_DIGITS } from "input-otp";
import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
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
import {
	InputOTP,
	InputOTPGroup,
	InputOTPSlot,
} from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { authClient, useSession } from "@/lib/auth-client";
import {
	getAuthErrorMessage,
	getSafeAuthRedirect,
	normalizeTwoFactorCode,
} from "@/lib/two-factor";

export function TwoFactorChallengePage() {
	const router = useRouter();
	const searchParams = useSearchParams();
	const { data: session, isPending } = useSession();
	const redirectTo = getSafeAuthRedirect(searchParams.get("redirect"));
	const [mode, setMode] = useState<"totp" | "backup">("totp");
	const [code, setCode] = useState("");
	const [trustDevice, setTrustDevice] = useState(false);
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);
	const normalizedCode = useMemo(() => normalizeTwoFactorCode(code), [code]);

	useEffect(() => {
		if (!isPending && session) {
			router.replace(redirectTo);
		}
	}, [isPending, redirectTo, router, session]);

	async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setError("");
		setLoading(true);

		const response =
			mode === "totp"
				? await authClient.twoFactor.verifyTotp({
						code: normalizedCode,
						trustDevice,
					})
				: await authClient.twoFactor.verifyBackupCode({
						code: normalizedCode,
						trustDevice,
					});

		setLoading(false);

		if (response.error) {
			setError(
				getAuthErrorMessage(
					response.error,
					mode === "totp"
						? "Invalid authenticator code"
						: "Invalid backup code",
				),
			);
			return;
		}

		router.push(redirectTo);
	}

	if (isPending || session) {
		return (
			<div className="min-h-screen flex items-center justify-center">
				<Spinner className="size-6" />
			</div>
		);
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
					<CardTitle>Two-Factor Authentication</CardTitle>
					<CardDescription>
						Enter the code from your authenticator app to continue
					</CardDescription>
				</CardHeader>
				<form onSubmit={(event) => void handleSubmit(event)}>
					<CardContent className="space-y-4 pb-4">
						{error && (
							<div className="text-sm text-destructive bg-destructive/10 p-3 rounded-lg">
								{error}
							</div>
						)}
						<div className="grid grid-cols-2 gap-2 rounded-lg bg-muted p-1">
							<Button
								type="button"
								variant={mode === "totp" ? "secondary" : "ghost"}
								size="sm"
								onClick={() => {
									setMode("totp");
									setCode("");
									setError("");
								}}
							>
								App code
							</Button>
							<Button
								type="button"
								variant={mode === "backup" ? "secondary" : "ghost"}
								size="sm"
								onClick={() => {
									setMode("backup");
									setCode("");
									setError("");
								}}
							>
								Backup code
							</Button>
						</div>
						<div className="space-y-2">
							<Label htmlFor="two-factor-code">
								{mode === "totp" ? "Authenticator code" : "Backup code"}
							</Label>
							{mode === "totp" ? (
								<InputOTP
									id="two-factor-code"
									maxLength={6}
									pattern={REGEXP_ONLY_DIGITS}
									inputMode="numeric"
									autoComplete="one-time-code"
									value={code}
									onChange={(value) => setCode(value.replace(/\D/g, ""))}
									required
									autoFocus
								>
									<InputOTPGroup>
										<InputOTPSlot index={0} />
										<InputOTPSlot index={1} />
										<InputOTPSlot index={2} />
										<InputOTPSlot index={3} />
										<InputOTPSlot index={4} />
										<InputOTPSlot index={5} />
									</InputOTPGroup>
								</InputOTP>
							) : (
								<Input
									id="two-factor-code"
									inputMode="text"
									autoComplete="one-time-code"
									value={code}
									onChange={(event) => setCode(event.target.value)}
									placeholder="XXXX-XXXX"
									required
									autoFocus
								/>
							)}
						</div>
						<div className="flex items-center justify-between gap-4 rounded-lg border p-3">
							<div>
								<Label htmlFor="trust-device">Trust this device</Label>
								<p className="text-xs text-muted-foreground">
									Skip 2FA on this browser for 30 days.
								</p>
							</div>
							<Switch
								id="trust-device"
								checked={trustDevice}
								onCheckedChange={setTrustDevice}
							/>
						</div>
					</CardContent>
					<CardFooter className="flex-col gap-4">
						<Button
							type="submit"
							className="w-full"
							disabled={
								loading ||
								(mode === "totp"
									? normalizedCode.length !== 6
									: normalizedCode.length === 0)
							}
						>
							{loading ? <Spinner className="size-4" /> : null}
							Verify
						</Button>
						<p className="text-sm text-muted-foreground">
							<Link href="/" className="text-primary hover:underline">
								Back to sign in
							</Link>
						</p>
					</CardFooter>
				</form>
			</Card>
		</div>
	);
}
