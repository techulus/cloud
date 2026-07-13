"use client";

import { ChevronDown } from "lucide-react";
import { parseAsStringLiteral, useQueryState } from "nuqs";
import useSWR from "swr";
import {
	type ServiceChartMode,
	ServiceMetricsPanel,
	type ServiceMetricsResponse,
} from "@/components/service/details/service-details-overview";
import { useService } from "@/components/service/service-layout-client";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { fetcher } from "@/lib/fetcher";
import { LOG_TIME_RANGES, type LogTimeRange } from "@/lib/log-query";

const LABELS: Record<LogTimeRange, string> = {
	"1h": "Last hour",
	"6h": "Last 6 hours",
	"24h": "Last 24 hours",
	"7d": "Last 7 days",
};
const MODES: ServiceChartMode[] = [
	"requests",
	"latency",
	"traffic",
	"resources",
];

export function ServiceMetricsPage() {
	const { service } = useService();
	const [range, setRange] = useQueryState(
		"range",
		parseAsStringLiteral(LOG_TIME_RANGES).withDefault("1h"),
	);
	const { data, error, isLoading } = useSWR<ServiceMetricsResponse>(
		`/api/services/${service.id}/metrics?range=${range}`,
		fetcher,
		{ refreshInterval: 60000, keepPreviousData: true },
	);
	const hasPublicHttp =
		service.ports?.some(
			(port) => port.isPublic && port.domain && port.protocol === "http",
		) ?? false;

	return (
		<div className="space-y-4">
			<div className="flex justify-end">
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<Button
								variant="outline"
								className="min-w-44 justify-between whitespace-nowrap"
							/>
						}
					>
						{LABELS[range]} <ChevronDown className="size-4" />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="min-w-44">
						<DropdownMenuRadioGroup
							value={range}
							onValueChange={(value) => setRange(value as typeof range)}
						>
							{LOG_TIME_RANGES.map((value) => (
								<DropdownMenuRadioItem key={value} value={value}>
									{LABELS[value]}
								</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			<div className="space-y-4">
				{MODES.map((mode) => (
					<div key={mode} className="h-80 rounded-lg border border-border">
						<ServiceMetricsPanel
							hasPublicHttp={hasPublicHttp}
							stats={data}
							error={error}
							isLoading={isLoading}
							fixedMode={mode}
							rangeLabel={range}
							useRangeAwareTimeAxis
						/>
					</div>
				))}
			</div>
		</div>
	);
}
