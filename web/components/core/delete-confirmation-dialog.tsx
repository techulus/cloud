"use client";

import { REGEXP_ONLY_DIGITS } from "input-otp";
import type { ReactNode } from "react";
import { useId, useState } from "react";
import { toast } from "sonner";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
	InputOTP,
	InputOTPGroup,
	InputOTPSlot,
} from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { useSession } from "@/lib/auth-client";
import type { DeleteConfirmation } from "@/lib/two-factor";

type TwoFactorSessionUser = {
	twoFactorEnabled?: boolean | null;
};

export function DeleteConfirmationDialog({
	resourceName,
	triggerLabel,
	description,
	fallbackError,
	onDelete,
}: {
	resourceName: string;
	triggerLabel: string;
	description: ReactNode;
	fallbackError: string;
	onDelete: (confirmation?: DeleteConfirmation) => Promise<void>;
}) {
	const {
		data: session,
		isPending: isSessionLoading,
		refetch: refetchSession,
	} = useSession();
	const sessionUser = session?.user as TwoFactorSessionUser | undefined;
	const totpInputId = useId();
	const [open, setOpen] = useState(false);
	const [totpCode, setTotpCode] = useState("");
	const [isDeleting, setIsDeleting] = useState(false);
	const requiresConfirmation = Boolean(sessionUser?.twoFactorEnabled);
	const isConfirmationIncomplete =
		requiresConfirmation && totpCode.length !== 6;

	const resetConfirmation = () => setTotpCode("");

	const handleDelete = async () => {
		if (isConfirmationIncomplete) {
			toast.error("Enter your 6-digit authenticator code");
			return;
		}

		setIsDeleting(true);
		try {
			await onDelete(
				requiresConfirmation
					? {
							totpCode,
						}
					: undefined,
			);
			setOpen(false);
			resetConfirmation();
		} catch (error) {
			if (!requiresConfirmation) {
				await refetchSession();
			}
			toast.error(error instanceof Error ? error.message : fallbackError);
			resetConfirmation();
		} finally {
			setIsDeleting(false);
		}
	};

	return (
		<AlertDialog
			open={open}
			onOpenChange={(nextOpen) => {
				if (isDeleting) return;
				setOpen(nextOpen);
				if (!nextOpen) resetConfirmation();
			}}
		>
			<AlertDialogTrigger render={<Button variant="destructive" />}>
				{triggerLabel}
			</AlertDialogTrigger>
			<AlertDialogContent className="sm:max-w-md">
				<AlertDialogHeader>
					<AlertDialogTitle>Delete {resourceName}?</AlertDialogTitle>
					<AlertDialogDescription>
						{description}
						{requiresConfirmation && (
							<>
								<br />
								<br />
								Enter your authenticator code to confirm this deletion.
							</>
						)}
					</AlertDialogDescription>
				</AlertDialogHeader>
				{requiresConfirmation && (
					<div className="space-y-2">
						<Label htmlFor={totpInputId}>Authenticator code</Label>
						<InputOTP
							id={totpInputId}
							maxLength={6}
							pattern={REGEXP_ONLY_DIGITS}
							inputMode="numeric"
							autoComplete="one-time-code"
							value={totpCode}
							onChange={(value) => setTotpCode(value.replace(/\D/g, ""))}
							disabled={isDeleting}
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
					</div>
				)}
				<AlertDialogFooter>
					<AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
					<AlertDialogAction
						variant="destructive"
						onClick={() => {
							void handleDelete();
						}}
						disabled={
							isDeleting || isSessionLoading || isConfirmationIncomplete
						}
					>
						{isDeleting ? <Spinner className="size-4" /> : null}
						{isDeleting ? "Deleting..." : "Delete"}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
