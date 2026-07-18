"use client";

import { ChevronDown } from "lucide-react";
import { parseAsStringLiteral, useQueryState } from "nuqs";
import useSWR from "swr";
import {
	type ServerMetricMode,
	ServerMetricsPanel,
	type ServerMetricsResponse,
} from "@/components/server/server-details-overview";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { fetcher } from "@/lib/fetcher";
import { METRIC_RANGE_KEYS, type MetricRange } from "@/lib/metric-ranges";

const RANGE_LABELS: Record<MetricRange, string> = {
	"1h": "Last hour",
	"6h": "Last 6 hours",
	"24h": "Last 24 hours",
	"7d": "Last 7 days",
	"30d": "Last 30 days",
};

const MODES: ServerMetricMode[] = ["cpu", "memory", "disk"];

export function ServerMetricsPage({ serverId }: { serverId: string }) {
	const [range, setRange] = useQueryState(
		"range",
		parseAsStringLiteral(METRIC_RANGE_KEYS).withDefault("1h"),
	);
	const { data, error, isLoading } = useSWR<ServerMetricsResponse>(
		`/api/servers/${serverId}/metrics?range=${range}`,
		fetcher,
		{ refreshInterval: 60000, keepPreviousData: true },
	);

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
						{RANGE_LABELS[range]} <ChevronDown className="size-4" />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="min-w-44">
						<DropdownMenuRadioGroup
							value={range}
							onValueChange={(value) => setRange(value as MetricRange)}
						>
							{METRIC_RANGE_KEYS.map((value) => (
								<DropdownMenuRadioItem key={value} value={value}>
									{RANGE_LABELS[value]}
								</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>

			<div className="space-y-4">
				{MODES.map((mode) => (
					<div key={mode} className="h-88 rounded-lg border border-border">
						<ServerMetricsPanel
							metrics={data}
							error={error}
							isLoading={isLoading}
							fixedMode={mode}
							range={range}
						/>
					</div>
				))}
			</div>
		</div>
	);
}
