import { Button, Heading, Section, Text } from "@react-email/components";
import { BaseEmail } from "./base";

type MemberInvitationProps = {
	inviterName: string;
	role: string;
	inviteUrl: string;
	baseUrl?: string;
};

export function MemberInvitation({
	inviterName,
	role,
	inviteUrl,
	baseUrl,
}: MemberInvitationProps) {
	return (
		<BaseEmail
			preview="You have been invited to Techulus Cloud"
			baseUrl={baseUrl}
		>
			<Heading style={headingStyle}>Techulus Cloud invitation</Heading>
			<Text style={paragraph}>
				{inviterName} invited you to join this Techulus Cloud instance as a{" "}
				{role}.
			</Text>
			<Section style={buttonContainer}>
				<Button style={button} href={inviteUrl}>
					Accept invitation
				</Button>
			</Section>
			<Text style={paragraph}>
				If the button does not work, open this link in your browser:
			</Text>
			<Text style={linkText}>{inviteUrl}</Text>
		</BaseEmail>
	);
}

const headingStyle = {
	fontSize: "24px",
	fontWeight: "600",
	lineHeight: "32px",
	color: "#1a1a1a",
	marginBottom: "16px",
};

const paragraph = {
	fontSize: "14px",
	lineHeight: "24px",
	color: "#525f7f",
	marginBottom: "16px",
};

const buttonContainer = {
	textAlign: "center" as const,
	marginTop: "24px",
	marginBottom: "24px",
};

const button = {
	backgroundColor: "#0f172a",
	borderRadius: "6px",
	color: "#ffffff",
	fontSize: "14px",
	fontWeight: "600",
	textDecoration: "none",
	padding: "12px 24px",
	display: "inline-block",
};

const linkText = {
	fontSize: "12px",
	lineHeight: "18px",
	color: "#334155",
	wordBreak: "break-all" as const,
};
