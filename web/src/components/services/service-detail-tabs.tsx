"use client";

import { ChevronDownIcon } from "lucide-react";
import Link from "next/link";
import classNames from "classnames";
import { usePathname } from "next/navigation";

export function ServiceDetailTabs({
	projectId,
	serviceId,
}: {
	projectId: string;
	serviceId: string;
}) {
	const pathname = usePathname();

	const tabs = [
		{
			name: "Deployments",
			href: `/dashboard/project/${projectId}/${serviceId}/deployments`,
			current: pathname.endsWith("deployments"),
		},
		{
			name: "Variables",
			href: `/dashboard/project/${projectId}/${serviceId}/variables`,
			current: pathname.endsWith("variables"),
		},
		{
			name: "Logs",
			href: `/dashboard/project/${projectId}/${serviceId}/logs`,
			current: pathname.endsWith("logs"),
		},
		{
			name: "Settings",
			href: `/dashboard/project/${projectId}/${serviceId}/settings`,
			current: pathname.endsWith("settings"),
		},
	];

	return (
		<div className="mt-2">
			<div className="grid grid-cols-1 sm:hidden">
				<select
					defaultValue={tabs.find((tab) => tab.current)?.name}
					onChange={(e) => {
						const tab = tabs.find((tab) => tab.name === e.target.value);
						if (tab) {
							window.location.href = tab.href;
						}
					}}
					aria-label="Select a tab"
					className="col-start-1 row-start-1 w-full appearance-none rounded-md bg-white dark:bg-zinc-800 py-2 pl-3 pr-8 text-gray-900 dark:text-gray-100 outline outline-1 -outline-offset-1 outline-gray-300 dark:outline-gray-600 focus:outline focus:outline-2 focus:-outline-offset-2 focus:outline-indigo-600"
				>
					{tabs.map((tab) => (
						<option key={tab.name}>{tab.name}</option>
					))}
				</select>
				<ChevronDownIcon
					aria-hidden="true"
					className="pointer-events-none col-start-1 row-start-1 mr-2 size-5 self-center justify-self-end fill-gray-500 dark:fill-gray-400"
				/>
			</div>
			<div className="hidden sm:block">
				<div className="border-b border-gray-200 dark:border-gray-800 pb-2">
					<nav aria-label="Tabs" className="-mb-px flex space-x-8">
						{tabs.map((tab) => (
							<Link
								key={tab.name}
								href={tab.href}
								aria-current={tab.current ? "page" : undefined}
								className={classNames(
									tab.current
										? "bg-gray-100 dark:bg-zinc-800 text-gray-700 dark:text-gray-200"
										: "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200",
									"rounded-md px-3 py-2 text-sm font-medium",
								)}
							>
								{tab.name}
							</Link>
						))}
					</nav>
				</div>
			</div>
		</div>
	);
}
