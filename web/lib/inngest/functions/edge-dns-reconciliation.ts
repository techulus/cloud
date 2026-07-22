import { cron } from "inngest";
import { reconcileEdgeDns } from "@/lib/edge-dns-service";
import { inngest } from "../client";

export const edgeDnsReconciliation = inngest.createFunction(
	{
		id: "edge-dns-reconciliation",
		triggers: [{ event: "edge-dns/reconcile" }, cron("*/5 * * * *")],
		// Events skipped during an active run converge through the repair cron.
		singleton: { mode: "skip" },
	},
	async ({ step }) => step.run("reconcile-edge-dns", reconcileEdgeDns),
);
