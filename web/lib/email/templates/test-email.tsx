import { Heading, Text } from "@react-email/components";
import { BaseEmail } from "./base";

type TestEmailProps = {
	baseUrl?: string;
};

export function TestEmail({ baseUrl }: TestEmailProps) {
	return (
		<BaseEmail preview="Test email from Techulus Cloud" baseUrl={baseUrl}>
			<Heading style={heading}>SMTP Configuration Test</Heading>
			<Text style={paragraph}>
				This is a test email to verify your SMTP configuration is working
				correctly.
			</Text>
			<Text style={paragraph}>
				If you received this email, your email settings are configured properly.
			</Text>
		</BaseEmail>
	);
}

const heading = {
	fontSize: "24px",
	fontWeight: "600",
	lineHeight: "32px",
	color: "#1a1a1a",
	marginBottom: "24px",
};

const paragraph = {
	fontSize: "14px",
	lineHeight: "24px",
	color: "#525f7f",
	marginBottom: "16px",
};
