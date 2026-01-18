import { Heading, Text, Section, Button } from "@react-email/components";
import { BaseEmail } from "./base";

type AlertDetail = {
	label: string;
	value: string;
};

type AlertProps = {
	bannerText: string;
	heading: string;
	description: string;
	details: AlertDetail[];
	note?: string;
	buttonText?: string;
	buttonUrl?: string;
	baseUrl?: string;
};

export function Alert({
	bannerText,
	heading,
	description,
	details,
	note,
	buttonText,
	buttonUrl,
	baseUrl,
}: AlertProps) {
	return (
		<BaseEmail preview={heading} baseUrl={baseUrl}>
			<Section style={alertBanner}>
				<Text style={alertText}>{bannerText}</Text>
			</Section>

			<Heading style={headingStyle}>{heading}</Heading>

			<Text style={paragraph}>{description}</Text>

			<Section style={detailsBox}>
				{details.map((detail, index) => (
					<div key={index}>
						<Text style={detailLabel}>{detail.label}</Text>
						<Text style={detailValue}>{detail.value}</Text>
					</div>
				))}
			</Section>

			{note && <Text style={paragraph}>{note}</Text>}

			{buttonText && buttonUrl && (
				<Section style={buttonContainer}>
					<Button style={button} href={buttonUrl}>
						{buttonText}
					</Button>
				</Section>
			)}
		</BaseEmail>
	);
}

const alertBanner = {
	backgroundColor: "#dc2626",
	borderRadius: "6px",
	padding: "12px 16px",
	marginBottom: "24px",
};

const alertText = {
	color: "#ffffff",
	fontSize: "12px",
	fontWeight: "700",
	letterSpacing: "0.5px",
	margin: "0",
	textAlign: "center" as const,
};

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

const detailsBox = {
	backgroundColor: "#f8fafc",
	borderRadius: "6px",
	padding: "16px",
	marginBottom: "24px",
};

const detailLabel = {
	fontSize: "12px",
	fontWeight: "600",
	color: "#64748b",
	margin: "0 0 4px 0",
	textTransform: "uppercase" as const,
	letterSpacing: "0.5px",
};

const detailValue = {
	fontSize: "14px",
	color: "#1e293b",
	margin: "0 0 12px 0",
};

const buttonContainer = {
	textAlign: "center" as const,
	marginTop: "24px",
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
