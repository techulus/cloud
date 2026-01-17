"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
	FileText,
	AlertTriangle,
	AlertCircle,
	Box,
	HardDrive,
	Check,
	ChevronRight,
	ChevronLeft,
	ArrowLeft,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
	parseComposeFile,
	importCompose,
	type ServiceOverride,
} from "@/actions/compose";
import type { ParsedService, ParseWarning, ParseError } from "@/lib/compose-parser";

type Step = "upload" | "preview" | "configure" | "importing" | "complete";

type ServiceConfig = {
	name: string;
	stateful: boolean;
};

type ImportComposeFormProps = {
	projectId: string;
	environmentId: string;
	slug: string;
	env: string;
};

export function ImportComposeForm({
	projectId,
	environmentId,
	slug,
	env,
}: ImportComposeFormProps) {
	const router = useRouter();
	const [step, setStep] = useState<Step>("upload");
	const [yamlContent, setYamlContent] = useState("");
	const [parsedServices, setParsedServices] = useState<ParsedService[]>([]);
	const [warnings, setWarnings] = useState<ParseWarning[]>([]);
	const [errors, setErrors] = useState<ParseError[]>([]);
	const [serviceConfigs, setServiceConfigs] = useState<Record<string, ServiceConfig>>({});
	const [isLoading, setIsLoading] = useState(false);
	const [importResult, setImportResult] = useState<{
		created: Array<{ name: string; serviceId: string }>;
		warnings: ParseWarning[];
	} | null>(null);

	const backUrl = `/dashboard/projects/${slug}/${env}`;

	const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (!file) return;
		const text = await file.text();
		setYamlContent(text);
	};

	const handleParse = async () => {
		if (!yamlContent.trim()) return;

		setIsLoading(true);
		setErrors([]);

		try {
			const result = await parseComposeFile(yamlContent);
			setParsedServices(result.services);
			setWarnings(result.warnings);
			setErrors(result.errors);

			const configs: Record<string, ServiceConfig> = {};
			for (const service of result.services) {
				configs[service.name] = {
					name: service.name,
					stateful: service.stateful,
				};
			}
			setServiceConfigs(configs);

			setStep("preview");
		} catch (err) {
			setErrors([{ message: err instanceof Error ? err.message : "Failed to parse YAML" }]);
		} finally {
			setIsLoading(false);
		}
	};

	const handleImport = async () => {
		setStep("importing");
		setIsLoading(true);

		try {
			const overrides: Record<string, ServiceOverride> = {};
			for (const [originalName, config] of Object.entries(serviceConfigs)) {
				const originalService = parsedServices.find((s) => s.name === originalName);
				if (originalService) {
					overrides[originalName] = {
						name: config.name !== originalName ? config.name : undefined,
						stateful: config.stateful !== originalService.stateful ? config.stateful : undefined,
					};
				}
			}

			const result = await importCompose({
				projectId,
				environmentId,
				yaml: yamlContent,
				serviceOverrides: overrides,
			});

			if (result.success) {
				setImportResult({
					created: result.created,
					warnings: result.warnings,
				});
				setStep("complete");
			} else {
				setErrors(result.errors);
				setWarnings(result.warnings);
				setStep("preview");
			}
		} catch (err) {
			setErrors([{ message: err instanceof Error ? err.message : "Import failed" }]);
			setStep("preview");
		} finally {
			setIsLoading(false);
		}
	};

	const updateServiceConfig = (serviceName: string, updates: Partial<ServiceConfig>) => {
		setServiceConfigs((prev) => ({
			...prev,
			[serviceName]: { ...prev[serviceName], ...updates },
		}));
	};

	const canProceedToConfigure = errors.length === 0 && parsedServices.length > 0;

	return (
		<div className="container max-w-5xl mx-auto px-4 py-8">
			<div className="mb-6">
				<Link
					href={backUrl}
					className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground mb-4"
				>
					<ArrowLeft className="h-4 w-4 mr-1" />
					Back to services
				</Link>
				<h1 className="text-2xl font-semibold">
					{step === "upload" ? "Import Docker Compose" : null}
					{step === "preview" ? "Preview Services" : null}
					{step === "configure" ? "Configure Services" : null}
					{step === "importing" ? "Importing..." : null}
					{step === "complete" ? "Import Complete" : null}
				</h1>
				<p className="text-muted-foreground mt-1">
					{step === "upload" ? "Upload or paste your Docker Compose file to import services." : null}
					{step === "preview" ? "Review the services that will be created." : null}
					{step === "configure" ? "Customize service names and settings before import." : null}
					{step === "importing" ? "Creating your services..." : null}
					{step === "complete" ? "Your services have been created successfully." : null}
				</p>
			</div>

			{step === "upload" ? (
				<div className="space-y-6">
					<div className="border rounded-lg p-6 space-y-4">
						<div className="space-y-2">
							<Label>Upload File</Label>
							<Input
								type="file"
								accept=".yml,.yaml"
								onChange={handleFileUpload}
							/>
						</div>

						<div className="relative">
							<div className="absolute inset-0 flex items-center">
								<span className="w-full border-t" />
							</div>
							<div className="relative flex justify-center text-xs uppercase">
								<span className="bg-background px-2 text-muted-foreground">Or paste YAML</span>
							</div>
						</div>

						<div className="space-y-2">
							<Label htmlFor="yaml-content">Docker Compose YAML</Label>
							<Textarea
								id="yaml-content"
								value={yamlContent}
								onChange={(e) => setYamlContent(e.target.value)}
								placeholder={`version: "3.8"
services:
  web:
    image: nginx:latest
    ports:
      - "80:80"`}
								className="font-mono text-sm min-h-[300px]"
							/>
						</div>
					</div>

					{errors.length > 0 ? (
						<Alert variant="destructive">
							<AlertCircle className="h-4 w-4" />
							<AlertTitle>Error</AlertTitle>
							<AlertDescription>
								{errors.map((err, i) => (
									<div key={i}>{err.message}</div>
								))}
							</AlertDescription>
						</Alert>
					) : null}

					<div className="flex justify-end">
						<Button
							onClick={handleParse}
							disabled={!yamlContent.trim() || isLoading}
							size="lg"
						>
							{isLoading ? "Parsing..." : "Continue"}
							<ChevronRight className="h-4 w-4 ml-1" />
						</Button>
					</div>
				</div>
			) : null}

			{step === "preview" ? (
				<div className="space-y-6">
					<div className="border rounded-lg p-6 space-y-4">
						<Label>Services to Import ({parsedServices.length})</Label>
						<div className="space-y-3">
							{parsedServices.map((service) => (
								<div
									key={service.name}
									className="border rounded-lg p-4 space-y-2"
								>
									<div className="flex items-center justify-between">
										<div className="flex items-center gap-2">
											<Box className="h-4 w-4 text-muted-foreground" />
											<span className="font-medium">{service.name}</span>
										</div>
										<div className="flex items-center gap-2">
											{service.stateful ? (
												<Badge variant="secondary">
													<HardDrive className="h-3 w-3 mr-1" />
													Stateful
												</Badge>
											) : null}
											{service.replicas > 1 ? (
												<Badge variant="outline">{service.replicas} replicas</Badge>
											) : null}
										</div>
									</div>
									<div className="text-sm text-muted-foreground space-y-1">
										<div className="flex items-center gap-2">
											<span className="text-foreground/70">Image:</span>
											<code className="bg-muted px-1.5 py-0.5 rounded text-xs">{service.image}</code>
										</div>
										{service.environment.length > 0 ? (
											<div className="flex items-center gap-2">
												<span className="text-foreground/70">Env vars:</span>
												<span>{service.environment.length}</span>
											</div>
										) : null}
										{service.volumes.length > 0 ? (
											<div className="flex items-center gap-2">
												<span className="text-foreground/70">Volumes:</span>
												<span>{service.volumes.map((v) => v.name).join(", ")}</span>
											</div>
										) : null}
										{service.startCommand ? (
											<div className="flex items-center gap-2">
												<span className="text-foreground/70">Command:</span>
												<code className="bg-muted px-1.5 py-0.5 rounded text-xs">{service.startCommand}</code>
											</div>
										) : null}
									</div>
								</div>
							))}
						</div>
					</div>

					{warnings.length > 0 ? (
						<Alert className="border-yellow-500/50 bg-yellow-500/10">
							<AlertTriangle className="h-4 w-4 text-yellow-600" />
							<AlertTitle className="text-yellow-700 dark:text-yellow-500">
								Warnings ({warnings.length})
							</AlertTitle>
							<AlertDescription className="text-yellow-700/80 dark:text-yellow-500/80">
								<ul className="list-disc list-inside space-y-1 mt-1">
									{warnings.map((w, i) => (
										<li key={i}>
											{w.service ? <strong>{w.service}:</strong> : null} {w.message}
										</li>
									))}
								</ul>
							</AlertDescription>
						</Alert>
					) : null}

					{errors.length > 0 ? (
						<Alert variant="destructive">
							<AlertCircle className="h-4 w-4" />
							<AlertTitle>Errors ({errors.length})</AlertTitle>
							<AlertDescription>
								<ul className="list-disc list-inside space-y-1 mt-1">
									{errors.map((e, i) => (
										<li key={i}>
											{e.service ? <strong>{e.service}:</strong> : null} {e.message}
										</li>
									))}
								</ul>
							</AlertDescription>
						</Alert>
					) : null}

					<p className="text-sm text-muted-foreground">
						Ports are not imported automatically. You can configure them after import.
					</p>

					<div className="flex justify-between">
						<Button variant="outline" onClick={() => setStep("upload")}>
							<ChevronLeft className="h-4 w-4 mr-1" />
							Back
						</Button>
						<Button
							onClick={() => setStep("configure")}
							disabled={!canProceedToConfigure}
							size="lg"
						>
							Configure
							<ChevronRight className="h-4 w-4 ml-1" />
						</Button>
					</div>
				</div>
			) : null}

			{step === "configure" ? (
				<div className="space-y-6">
					<div className="space-y-4">
						{parsedServices.map((service) => {
							const config = serviceConfigs[service.name];
							if (!config) return null;

							return (
								<div
									key={service.name}
									className="border rounded-lg p-6 space-y-4"
								>
									<div className="flex items-center gap-2 text-sm text-muted-foreground">
										<FileText className="h-4 w-4" />
										<span>Original: {service.name}</span>
									</div>

									<div className="space-y-2">
										<Label htmlFor={`name-${service.name}`}>Service Name</Label>
										<Input
											id={`name-${service.name}`}
											value={config.name}
											onChange={(e) =>
												updateServiceConfig(service.name, { name: e.target.value })
											}
										/>
									</div>

									<div className="flex items-center justify-between">
										<div className="space-y-0.5">
											<Label htmlFor={`stateful-${service.name}`}>Stateful</Label>
											<p className="text-sm text-muted-foreground">
												{service.volumes.length > 0
													? "Has volumes - recommended to keep enabled"
													: "Enable for persistent storage"}
											</p>
										</div>
										<Switch
											id={`stateful-${service.name}`}
											checked={config.stateful}
											onCheckedChange={(checked) =>
												updateServiceConfig(service.name, { stateful: checked })
											}
										/>
									</div>
								</div>
							);
						})}
					</div>

					<div className="flex justify-between">
						<Button variant="outline" onClick={() => setStep("preview")}>
							<ChevronLeft className="h-4 w-4 mr-1" />
							Back
						</Button>
						<Button onClick={handleImport} size="lg">
							Import {parsedServices.length} Service{parsedServices.length !== 1 ? "s" : ""}
						</Button>
					</div>
				</div>
			) : null}

			{step === "importing" ? (
				<div className="border rounded-lg p-12 text-center space-y-4">
					<div className="animate-spin h-10 w-10 border-2 border-primary border-t-transparent rounded-full mx-auto" />
					<p className="text-muted-foreground">Creating services...</p>
				</div>
			) : null}

			{step === "complete" && importResult ? (
				<div className="space-y-6">
					<div className="border rounded-lg p-8 text-center space-y-4">
						<div className="h-14 w-14 rounded-full bg-green-500/10 flex items-center justify-center mx-auto">
							<Check className="h-7 w-7 text-green-500" />
						</div>
						<p className="text-lg font-medium">
							Successfully imported {importResult.created.length} service
							{importResult.created.length !== 1 ? "s" : ""}
						</p>
					</div>

					<div className="border rounded-lg p-6 space-y-3">
						{importResult.created.map((service) => (
							<div
								key={service.serviceId}
								className="flex items-center gap-2 p-3 bg-muted/50 rounded-lg"
							>
								<Check className="h-4 w-4 text-green-500" />
								<span className="font-medium">{service.name}</span>
							</div>
						))}
					</div>

					{importResult.warnings.length > 0 ? (
						<Alert className="border-yellow-500/50 bg-yellow-500/10">
							<AlertTriangle className="h-4 w-4 text-yellow-600" />
							<AlertTitle className="text-yellow-700 dark:text-yellow-500">Notes</AlertTitle>
							<AlertDescription className="text-yellow-700/80 dark:text-yellow-500/80">
								<ul className="list-disc list-inside space-y-1 mt-1">
									{importResult.warnings.map((w, i) => (
										<li key={i}>
											{w.service ? <strong>{w.service}:</strong> : null} {w.message}
										</li>
									))}
								</ul>
							</AlertDescription>
						</Alert>
					) : null}

					<p className="text-sm text-muted-foreground text-center">
						Services are created but not deployed. Review configuration and deploy when ready.
					</p>

					<div className="flex justify-center">
						<Button onClick={() => router.push(backUrl)} size="lg">
							View Services
						</Button>
					</div>
				</div>
			) : null}
		</div>
	);
}
