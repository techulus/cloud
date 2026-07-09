"use client";

import {
	Copy,
	KeyRound,
	RefreshCw,
	ShieldCheck,
	ShieldOff,
} from "lucide-react";
import Image from "next/image";
import QRCode from "qrcode";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Item, ItemContent, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { authClient, useSession } from "@/lib/auth-client";
import { getTotpSecret } from "@/lib/two-factor";

type AuthClientError = {
	message?: string;
	error_description?: string;
} | null;

type TwoFactorSessionUser = {
	twoFactorEnabled?: boolean | null;
};

type PendingSetup = {
	totpURI: string;
	secret: string;
	backupCodes: string[];
};

function getErrorMessage(error: AuthClientError, fallback: string) {
	return error?.message || error?.error_description || fallback;
}

function normalizeCode(value: string) {
	return value.replace(/\s/g, "");
}

async function copyToClipboard(label: string, value: string) {
	try {
		await navigator.clipboard.writeText(value);
		toast.success(`${label} copied`);
	} catch {
		toast.error(`Failed to copy ${label.toLowerCase()}`);
	}
}

function BackupCodes({
	codes,
	title = "Backup codes",
}: {
	codes: string[];
	title?: string;
}) {
	if (codes.length === 0) return null;

	return (
		<Alert>
			<ShieldCheck className="size-4" />
			<AlertTitle>{title}</AlertTitle>
			<AlertDescription className="space-y-3">
				<p>
					Store these codes somewhere safe. Each code can be used once if your
					authenticator app is unavailable.
				</p>
				<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
					{codes.map((code) => (
						<div
							key={code}
							className="rounded-md border bg-muted px-3 py-2 font-mono text-sm text-foreground"
						>
							{code}
						</div>
					))}
				</div>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => void copyToClipboard("Backup codes", codes.join("\n"))}
				>
					<Copy className="size-4" />
					Copy codes
				</Button>
			</AlertDescription>
		</Alert>
	);
}

export function TwoFactorSettings() {
	const { data: session, refetch } = useSession();
	const sessionUser = session?.user as TwoFactorSessionUser | undefined;
	const [setupPassword, setSetupPassword] = useState("");
	const [verificationCode, setVerificationCode] = useState("");
	const [pendingSetup, setPendingSetup] = useState<PendingSetup | null>(null);
	const [setupQrCode, setSetupQrCode] = useState("");
	const [backupPassword, setBackupPassword] = useState("");
	const [disablePassword, setDisablePassword] = useState("");
	const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
	const [isStartingSetup, setIsStartingSetup] = useState(false);
	const [isVerifying, setIsVerifying] = useState(false);
	const [isGeneratingCodes, setIsGeneratingCodes] = useState(false);
	const [isDisabling, setIsDisabling] = useState(false);

	const isEnabled = Boolean(
		sessionUser?.twoFactorEnabled || recoveryCodes.length,
	);
	const formattedVerificationCode = useMemo(
		() => normalizeCode(verificationCode),
		[verificationCode],
	);

	useEffect(() => {
		if (!pendingSetup?.totpURI) {
			setSetupQrCode("");
			return;
		}

		let shouldUseResult = true;

		QRCode.toDataURL(pendingSetup.totpURI, {
			errorCorrectionLevel: "M",
			margin: 2,
			width: 192,
			color: {
				dark: "#000000",
				light: "#ffffff",
			},
		})
			.then((dataUrl) => {
				if (shouldUseResult) setSetupQrCode(dataUrl);
			})
			.catch(() => {
				if (shouldUseResult) setSetupQrCode("");
			});

		return () => {
			shouldUseResult = false;
		};
	}, [pendingSetup?.totpURI]);

	function refreshSession() {
		return refetch({ query: { disableCookieCache: true } });
	}

	async function handleStartSetup(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setIsStartingSetup(true);

		try {
			const response = await authClient.twoFactor.enable({
				password: setupPassword,
			});

			if (response.error || !response.data?.totpURI) {
				throw new Error(
					getErrorMessage(response.error, "Failed to start 2FA setup"),
				);
			}

			setPendingSetup({
				totpURI: response.data.totpURI,
				secret: getTotpSecret(response.data.totpURI),
				backupCodes: response.data.backupCodes ?? [],
			});
			setSetupPassword("");
			setVerificationCode("");
			setRecoveryCodes([]);
			toast.success("Authenticator setup started");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to start 2FA setup",
			);
		} finally {
			setIsStartingSetup(false);
		}
	}

	async function handleVerifySetup(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!pendingSetup) return;

		setIsVerifying(true);
		try {
			const response = await authClient.twoFactor.verifyTotp({
				code: formattedVerificationCode,
			});

			if (response.error) {
				throw new Error(
					getErrorMessage(
						response.error,
						"Failed to verify authenticator code",
					),
				);
			}

			setRecoveryCodes(pendingSetup.backupCodes);
			setPendingSetup(null);
			setVerificationCode("");
			await refreshSession();
			toast.success("Two-factor authentication enabled");
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to verify authenticator code",
			);
		} finally {
			setIsVerifying(false);
		}
	}

	async function handleGenerateBackupCodes(
		event: React.FormEvent<HTMLFormElement>,
	) {
		event.preventDefault();
		setIsGeneratingCodes(true);

		try {
			const response = await authClient.twoFactor.generateBackupCodes({
				password: backupPassword,
			});

			if (response.error || !response.data?.backupCodes) {
				throw new Error(
					getErrorMessage(response.error, "Failed to generate backup codes"),
				);
			}

			setRecoveryCodes(response.data.backupCodes);
			setBackupPassword("");
			toast.success("Backup codes regenerated");
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to generate backup codes",
			);
		} finally {
			setIsGeneratingCodes(false);
		}
	}

	async function handleDisable(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setIsDisabling(true);

		try {
			const response = await authClient.twoFactor.disable({
				password: disablePassword,
			});

			if (response.error || response.data?.status !== true) {
				throw new Error(
					getErrorMessage(response.error, "Failed to disable 2FA"),
				);
			}

			setDisablePassword("");
			setBackupPassword("");
			setRecoveryCodes([]);
			setPendingSetup(null);
			await refreshSession();
			toast.success("Two-factor authentication disabled");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to disable 2FA",
			);
		} finally {
			setIsDisabling(false);
		}
	}

	return (
		<div className="rounded-lg border">
			<Item className="border-0 border-b rounded-none">
				<ItemMedia variant="icon">
					<ShieldCheck className="size-5 text-muted-foreground" />
				</ItemMedia>
				<ItemContent>
					<div className="flex flex-wrap items-center gap-2">
						<ItemTitle>Two-Factor Authentication</ItemTitle>
						<Badge variant={isEnabled ? "secondary" : "outline"}>
							{isEnabled ? "Enabled" : "Off"}
						</Badge>
					</div>
					<p className="text-sm text-muted-foreground">
						Use an authenticator app to protect your account with a 6-digit
						code.
					</p>
				</ItemContent>
			</Item>

			<div className="space-y-5 p-4">
				{pendingSetup ? (
					<div className="space-y-5">
						<div className="space-y-3">
							<div>
								<p className="text-sm font-medium">Set up your app</p>
								<p className="text-sm text-muted-foreground">
									Scan the QR code or add the setup key to your authenticator
									app, then enter the current 6-digit code.
								</p>
							</div>

							<div className="grid gap-3">
								<div className="flex flex-col gap-4 rounded-lg border bg-muted/30 p-4 sm:flex-row sm:items-center">
									<div className="flex size-48 shrink-0 items-center justify-center rounded-md border bg-white p-3">
										{setupQrCode ? (
											<Image
												src={setupQrCode}
												alt="Authenticator setup QR code"
												width={168}
												height={168}
												unoptimized
												className="size-full object-contain"
											/>
										) : (
											<Spinner className="size-5 text-muted-foreground" />
										)}
									</div>
									<div className="space-y-1">
										<p className="text-sm font-medium">Scan QR code</p>
										<p className="text-sm text-muted-foreground">
											Use Google Authenticator, 1Password, Authy, or another
											TOTP-compatible app.
										</p>
									</div>
								</div>
								<div className="space-y-2">
									<Label htmlFor="totp-secret">Setup key</Label>
									<div className="flex gap-2">
										<Input
											id="totp-secret"
											value={pendingSetup.secret}
											readOnly
											className="font-mono"
										/>
										<Button
											type="button"
											variant="outline"
											onClick={() =>
												void copyToClipboard("Setup key", pendingSetup.secret)
											}
										>
											<Copy className="size-4" />
											Copy
										</Button>
									</div>
								</div>
								<div className="space-y-2">
									<Label htmlFor="totp-uri">Authenticator URI</Label>
									<div className="flex gap-2">
										<Input
											id="totp-uri"
											value={pendingSetup.totpURI}
											readOnly
											className="font-mono"
										/>
										<Button
											type="button"
											variant="outline"
											onClick={() =>
												void copyToClipboard(
													"Authenticator URI",
													pendingSetup.totpURI,
												)
											}
										>
											<Copy className="size-4" />
											Copy
										</Button>
									</div>
								</div>
							</div>
						</div>

						<form onSubmit={(event) => void handleVerifySetup(event)}>
							<div className="space-y-4">
								<div className="space-y-2">
									<Label htmlFor="totp-code">Authenticator code</Label>
									<Input
										id="totp-code"
										inputMode="numeric"
										autoComplete="one-time-code"
										value={verificationCode}
										onChange={(event) =>
											setVerificationCode(event.target.value)
										}
										placeholder="123456"
										required
									/>
								</div>
								<div className="flex flex-wrap gap-2">
									<Button
										type="submit"
										disabled={
											isVerifying || formattedVerificationCode.length === 0
										}
									>
										{isVerifying ? <Spinner className="size-4" /> : null}
										Verify and enable
									</Button>
									<Button
										type="button"
										variant="outline"
										onClick={() => {
											setPendingSetup(null);
											setVerificationCode("");
										}}
										disabled={isVerifying}
									>
										Cancel setup
									</Button>
								</div>
							</div>
						</form>
					</div>
				) : isEnabled ? (
					<div className="space-y-5">
						<Alert>
							<ShieldCheck className="size-4" />
							<AlertTitle>2FA is enabled</AlertTitle>
							<AlertDescription>
								Your next password sign-in will require a code from your
								authenticator app unless this device is trusted.
							</AlertDescription>
						</Alert>

						<BackupCodes codes={recoveryCodes} title="New backup codes" />

						<form
							onSubmit={(event) => void handleGenerateBackupCodes(event)}
							className="rounded-lg border p-4"
						>
							<div className="space-y-4">
								<div>
									<p className="text-sm font-medium">Regenerate backup codes</p>
									<p className="text-sm text-muted-foreground">
										This replaces any existing backup codes.
									</p>
								</div>
								<div className="space-y-2">
									<Label htmlFor="backup-password">Current password</Label>
									<Input
										id="backup-password"
										type="password"
										value={backupPassword}
										onChange={(event) => setBackupPassword(event.target.value)}
										required
									/>
								</div>
								<Button type="submit" disabled={isGeneratingCodes}>
									{isGeneratingCodes ? (
										<Spinner className="size-4" />
									) : (
										<RefreshCw className="size-4" />
									)}
									Regenerate codes
								</Button>
							</div>
						</form>

						<form
							onSubmit={(event) => void handleDisable(event)}
							className="rounded-lg border border-destructive/40 p-4"
						>
							<div className="space-y-4">
								<div>
									<p className="text-sm font-medium">Disable 2FA</p>
									<p className="text-sm text-muted-foreground">
										Password-only sign-in will be allowed again for this
										account.
									</p>
								</div>
								<div className="space-y-2">
									<Label htmlFor="disable-password">Current password</Label>
									<Input
										id="disable-password"
										type="password"
										value={disablePassword}
										onChange={(event) => setDisablePassword(event.target.value)}
										required
									/>
								</div>
								<Button
									type="submit"
									variant="destructive"
									disabled={isDisabling}
								>
									{isDisabling ? (
										<Spinner className="size-4" />
									) : (
										<ShieldOff className="size-4" />
									)}
									Disable 2FA
								</Button>
							</div>
						</form>
					</div>
				) : (
					<form onSubmit={(event) => void handleStartSetup(event)}>
						<div className="space-y-4">
							<div>
								<p className="text-sm font-medium">Enable authenticator app</p>
								<p className="text-sm text-muted-foreground">
									You will enter your password, add a setup key to your
									authenticator app, then verify the current code.
								</p>
							</div>
							<div className="space-y-2">
								<Label htmlFor="setup-password">Current password</Label>
								<Input
									id="setup-password"
									type="password"
									value={setupPassword}
									onChange={(event) => setSetupPassword(event.target.value)}
									required
								/>
							</div>
							<Button type="submit" disabled={isStartingSetup}>
								{isStartingSetup ? (
									<Spinner className="size-4" />
								) : (
									<KeyRound className="size-4" />
								)}
								Start setup
							</Button>
						</div>
					</form>
				)}
			</div>
		</div>
	);
}
