import Link from "next/link";
import { getInviteByToken } from "@/actions/members";
import { AcceptInvitePage } from "@/components/auth/accept-invite-page";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";

type Props = {
	params: Promise<{ token: string }>;
};

function InvalidInvitePage({ status }: { status?: string }) {
	return (
		<div className="min-h-screen flex items-center justify-center p-4">
			<Card className="w-full max-w-md">
				<CardHeader>
					<CardTitle>Invitation unavailable</CardTitle>
					<CardDescription>
						This invitation is {status ?? "invalid"} or no longer available.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<p className="text-sm text-muted-foreground">
						Ask your administrator to send a new invitation.
					</p>
				</CardContent>
				<CardFooter>
					<Button className="w-full" render={<Link href="/" />}>
						Back to sign in
					</Button>
				</CardFooter>
			</Card>
		</div>
	);
}

export default async function InvitePage({ params }: Props) {
	const { token } = await params;
	const invite = await getInviteByToken(token);

	if (!invite || invite.status !== "pending") {
		return <InvalidInvitePage status={invite?.status} />;
	}

	return (
		<AcceptInvitePage token={token} email={invite.email} role={invite.role} />
	);
}
