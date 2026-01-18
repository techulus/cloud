import { Heading, Text, Section, Button } from "@react-email/components";
import { BaseEmail } from "./base";

type ServerOfflineAlertProps = {
	serverName: string;
	serverIp?: string;
	detectedAt: Date;
	dashboardUrl?: string;
	baseUrl?: string;
};

export function ServerOfflineAlert({
	serverName,
	serverIp,
	detectedAt,
	dashboardUrl,
	baseUrl,
}: ServerOfflineAlertProps) {
	const formattedTime = detectedAt.toLocaleString("en-US", {
		dateStyle: "medium",
		timeStyle: "short",
	});

	return (
		<BaseEmail
			preview={`Alert: Server "${serverName}" is offline`}
			baseUrl={baseUrl}
		>
			<Section style={alertBanner}>
				<Text style={alertText}>SERVER OFFLINE</Text>
			</Section>

			<Heading style={heading}>Server Offline Alert</Heading>

			<Text style={paragraph}>
				The server <strong>{serverName}</strong> has gone offline and is no
				longer responding to health checks.
			</Text>

			<Section style={detailsBox}>
				<Text style={detailLabel}>Server Name</Text>
				<Text style={detailValue}>{serverName}</Text>

				{serverIp && (
					<>
						<Text style={detailLabel}>IP Address</Text>
						<Text style={detailValue}>{serverIp}</Text>
					</>
				)}

				<Text style={detailLabel}>Detected At</Text>
				<Text style={detailValue}>{formattedTime}</Text>
			</Section>

			<Text style={paragraph}>
				Auto-placed stateless services running on this server will be
				automatically recovered and redeployed to healthy servers.
			</Text>

			{dashboardUrl && (
				<Section style={buttonContainer}>
					<Button style={button} href={dashboardUrl}>
						View Dashboard
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

const heading = {
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
