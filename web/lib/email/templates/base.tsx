import {
	Body,
	Container,
	Head,
	Html,
	Img,
	Preview,
	Section,
	Text,
} from "@react-email/components";
import type { ReactNode } from "react";

type BaseEmailProps = {
	preview: string;
	children: ReactNode;
	baseUrl?: string;
};

export function BaseEmail({ preview, children, baseUrl }: BaseEmailProps) {
	const logoUrl = baseUrl ? `${baseUrl}/logo.png` : "/logo.png";

	return (
		<Html>
			<Head />
			<Preview>{preview}</Preview>
			<Body style={body}>
				<Container style={container}>
					<Section style={header}>
						<Img src={logoUrl} width="48" height="48" alt="Techulus Cloud" />
					</Section>
					<Section style={content}>{children}</Section>
					<Text style={footer}>Sent from Techulus Cloud</Text>
				</Container>
			</Body>
		</Html>
	);
}

const body = {
	backgroundColor: "#f6f9fc",
	fontFamily:
		'-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Ubuntu, sans-serif',
};

const container = {
	backgroundColor: "#ffffff",
	margin: "0 auto",
	padding: "12px 0 32px",
	marginBottom: "64px",
	maxWidth: "600px",
};

const header = {
	padding: "16px 24px 0",
};

const content = {
	padding: "16px 24px",
};

const footer = {
	color: "#8898aa",
	fontSize: "12px",
	lineHeight: "16px",
	textAlign: "center" as const,
	marginTop: "32px",
};
