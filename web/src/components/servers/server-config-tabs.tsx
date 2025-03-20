"use client";

import type { server } from "@/db/schema";
import { ChevronDownIcon } from "lucide-react";
import classNames from "classnames";
import { useState } from "react";
import { Badge } from "../ui/badge";

export function ServerConfigTabs({
	serverDetails,
}: {
	serverDetails: typeof server.$inferSelect;
}) {
	const [activeTab, setActiveTab] = useState("containers");

	const tabs = [
		{ name: "Containers", id: "containers" },
		{ name: "Images", id: "images" },
		{ name: "Networks", id: "networks" },
	];

	const renderTabContent = () => {
		switch (activeTab) {
			case "containers":
				return (
					<div className="mt-4">
						{serverDetails.configuration?.containers.map((container) => (
							<div
								key={container.Id}
								className="mb-4 p-4 rounded-lg border border-gray-200 dark:border-gray-800"
							>
								<div className="font-medium">{container.Id}</div>
								<div className="text-sm text-gray-700 dark:text-gray-400 space-y-1">
									<div>
										<Badge color="purple">Image</Badge> {container.Image}
									</div>
									<div>
										<Badge color="purple">Status</Badge> {container.Status}
									</div>
									<div>
										<Badge color="purple">IP</Badge>
										{container.NetworkSettings.Networks.bridge.IPAddress}
									</div>
								</div>
							</div>
						))}
					</div>
				);
			case "images":
				return (
					<div className="mt-4 text-gray-700 dark:text-gray-400">
						{serverDetails.configuration?.images.length === 0 ? (
							<p>No images found</p>
						) : (
							serverDetails.configuration?.images.map((image) => (
								<div key={image.Id}>Image details here</div>
							))
						)}
					</div>
				);
			case "networks":
				return (
					<div className="mt-4 text-gray-700 dark:text-gray-400">
						{serverDetails.configuration?.networks.length === 0 ? (
							<p>No networks found</p>
						) : (
							serverDetails.configuration?.networks.map((network) => (
								<div key={network.Id}>Network details here</div>
							))
						)}
					</div>
				);
		}
	};

	return (
		<div className="mt-2">
			<div className="grid grid-cols-1 sm:hidden">
				<select
					value={activeTab}
					onChange={(e) => setActiveTab(e.target.value)}
					className="col-start-1 row-start-1 w-full appearance-none rounded-md bg-white dark:bg-zinc-800 py-2 pl-3 pr-8 text-gray-900 dark:text-gray-100 outline outline-1 -outline-offset-1 outline-gray-300 dark:outline-gray-600"
				>
					{tabs.map((tab) => (
						<option key={tab.id} value={tab.id}>
							{tab.name}
						</option>
					))}
				</select>
				<ChevronDownIcon className="pointer-events-none col-start-1 row-start-1 mr-2 size-5 self-center justify-self-end fill-gray-500 dark:fill-gray-400" />
			</div>

			<div className="hidden sm:block">
				<div className="border-b border-gray-200 dark:border-gray-800 pb-2">
					<nav className="-mb-px flex space-x-8">
						{tabs.map((tab) => (
							<button
								type="button"
								key={tab.id}
								onClick={() => setActiveTab(tab.id)}
								className={classNames(
									activeTab === tab.id
										? "bg-gray-100 dark:bg-zinc-800 text-gray-700 dark:text-gray-200"
										: "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200",
									"rounded-md px-3 py-2 text-sm font-medium",
								)}
							>
								{tab.name}
							</button>
						))}
					</nav>
				</div>
			</div>

			{renderTabContent()}
		</div>
	);
}
