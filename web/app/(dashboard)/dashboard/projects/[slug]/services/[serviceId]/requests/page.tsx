"use client";

import { useService } from "@/components/service-layout-client";
import { RequestsViewer } from "@/components/service-details/requests-viewer";

export default function RequestsPage() {
	const { service } = useService();

	return <RequestsViewer serviceId={service.id} />;
}
