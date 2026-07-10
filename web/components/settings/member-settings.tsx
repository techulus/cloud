"use client";

import { Copy, MailPlus, Trash2, UserRoundCog, X } from "lucide-react";
import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import { useState } from "react";
import { toast } from "sonner";
import {
	inviteMember,
	removeMember,
	revokeInvitation,
	updateMemberRole,
} from "@/actions/members";
import { LocalDate } from "@/components/core/local-date";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Item, ItemContent, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import type { InvitableMemberRole, MemberRole } from "@/db/types";

type MemberRecord = {
	id: string;
	name: string;
	email: string;
	role: MemberRole;
	createdAt: string | Date;
};

type InvitationRecord = {
	id: string;
	email: string;
	role: InvitableMemberRole;
	status: string;
	expiresAt: string | Date;
	createdAt: string | Date;
};

type Props = {
	initialMembers: MemberRecord[];
	initialInvitations: InvitationRecord[];
};

const roleBadgeVariants = {
	admin: "default",
	developer: "secondary",
	reader: "outline",
} as const;

export function MemberSettings({ initialMembers, initialInvitations }: Props) {
	const router = useRouter();
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<InvitableMemberRole>("developer");
	const [isInviting, setIsInviting] = useState(false);
	const [busyId, setBusyId] = useState<string | null>(null);

	async function copyInviteLink(inviteUrl: string) {
		await navigator.clipboard.writeText(inviteUrl);
		toast.success("Invite link copied");
	}

	async function handleInvite(event: FormEvent) {
		event.preventDefault();
		setIsInviting(true);
		try {
			const result = await inviteMember({ email, role });
			if (!result.success) {
				toast.error(result.error);
				return;
			}

			setEmail("");
			toast.success(
				result.emailSent ? "Invitation sent" : "Invitation created",
			);
			await copyInviteLink(result.inviteUrl);
			router.refresh();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to invite member",
			);
		} finally {
			setIsInviting(false);
		}
	}

	async function handleRoleChange(
		memberId: string,
		nextRole: InvitableMemberRole,
	) {
		setBusyId(memberId);
		try {
			await updateMemberRole(memberId, nextRole);
			toast.success("Role updated");
			router.refresh();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to update role",
			);
		} finally {
			setBusyId(null);
		}
	}

	async function handleRemove(member: MemberRecord) {
		if (!window.confirm(`Remove ${member.email} from this instance?`)) {
			return;
		}
		setBusyId(member.id);
		try {
			await removeMember(member.id);
			toast.success("Member removed");
			router.refresh();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to remove member",
			);
		} finally {
			setBusyId(null);
		}
	}

	async function handleRevoke(invitationId: string) {
		setBusyId(invitationId);
		try {
			await revokeInvitation(invitationId);
			toast.success("Invitation revoked");
			router.refresh();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to revoke invitation",
			);
		} finally {
			setBusyId(null);
		}
	}

	return (
		<div className="space-y-6">
			<div className="rounded-lg border">
				<Item className="border-0 border-b rounded-none">
					<ItemMedia variant="icon">
						<MailPlus className="size-5 text-muted-foreground" />
					</ItemMedia>
					<ItemContent>
						<ItemTitle>Invite Member</ItemTitle>
					</ItemContent>
				</Item>
				<form
					onSubmit={(event) => void handleInvite(event)}
					className="grid gap-4 p-4 md:grid-cols-[minmax(0,1fr)_180px_auto]"
				>
					<div className="space-y-2">
						<Label htmlFor="member-email">Email</Label>
						<Input
							id="member-email"
							type="email"
							value={email}
							onChange={(event) => setEmail(event.target.value)}
							placeholder="teammate@example.com"
							required
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="member-role">Role</Label>
						<NativeSelect
							id="member-role"
							value={role}
							onChange={(event) =>
								setRole(event.target.value as InvitableMemberRole)
							}
							className="w-full"
						>
							<NativeSelectOption value="developer">
								Developer
							</NativeSelectOption>
							<NativeSelectOption value="reader">Reader</NativeSelectOption>
						</NativeSelect>
					</div>
					<div className="flex items-end">
						<Button type="submit" disabled={isInviting} className="w-full">
							<MailPlus className="size-4" />
							{isInviting ? "Inviting..." : "Invite"}
						</Button>
					</div>
				</form>
			</div>

			<div className="rounded-lg border">
				<Item className="border-0 border-b rounded-none">
					<ItemMedia variant="icon">
						<UserRoundCog className="size-5 text-muted-foreground" />
					</ItemMedia>
					<ItemContent>
						<ItemTitle>Members</ItemTitle>
					</ItemContent>
				</Item>
				<div className="divide-y">
					{initialMembers.map((member) => (
						<div
							key={member.id}
							className="grid gap-3 p-4 md:grid-cols-[minmax(0,1fr)_160px_auto] md:items-center"
						>
							<div className="min-w-0">
								<div className="flex flex-wrap items-center gap-2">
									<p className="font-medium">{member.name}</p>
									<Badge variant={roleBadgeVariants[member.role]}>
										{member.role}
									</Badge>
								</div>
								<p className="truncate text-sm text-muted-foreground">
									{member.email}
								</p>
								<p className="text-xs text-muted-foreground">
									Joined{" "}
									<LocalDate value={member.createdAt} fallback="Unknown" />
								</p>
							</div>
							{member.role === "admin" ? (
								<p className="text-sm text-muted-foreground">Single admin</p>
							) : (
								<NativeSelect
									value={member.role}
									onChange={(event) =>
										void handleRoleChange(
											member.id,
											event.target.value as InvitableMemberRole,
										)
									}
									disabled={busyId === member.id}
									className="w-full"
								>
									<NativeSelectOption value="developer">
										Developer
									</NativeSelectOption>
									<NativeSelectOption value="reader">Reader</NativeSelectOption>
								</NativeSelect>
							)}
							{member.role !== "admin" && (
								<div className="flex justify-end">
									<Button
										type="button"
										variant="ghost"
										size="icon"
										disabled={busyId === member.id}
										onClick={() => void handleRemove(member)}
										title="Remove member"
									>
										<Trash2 className="size-4" />
									</Button>
								</div>
							)}
						</div>
					))}
				</div>
			</div>

			{initialInvitations.length > 0 && (
				<div className="rounded-lg border">
					<Item className="border-0 border-b rounded-none">
						<ItemMedia variant="icon">
							<Copy className="size-5 text-muted-foreground" />
						</ItemMedia>
						<ItemContent>
							<ItemTitle>Pending Invitations</ItemTitle>
						</ItemContent>
					</Item>
					<div className="divide-y">
						{initialInvitations.map((invitation) => (
							<div
								key={invitation.id}
								className="grid gap-3 p-4 md:grid-cols-[minmax(0,1fr)_120px_auto] md:items-center"
							>
								<div className="min-w-0">
									<p className="truncate font-medium">{invitation.email}</p>
									<p className="text-xs text-muted-foreground">
										Expires{" "}
										<LocalDate
											value={invitation.expiresAt}
											fallback="Unknown"
										/>
									</p>
								</div>
								<Badge variant="outline">{invitation.role}</Badge>
								<div className="flex justify-end">
									<Button
										type="button"
										variant="ghost"
										size="icon"
										disabled={busyId === invitation.id}
										onClick={() => void handleRevoke(invitation.id)}
										title="Revoke invitation"
									>
										<X className="size-4" />
									</Button>
								</div>
							</div>
						))}
					</div>
				</div>
			)}
		</div>
	);
}
