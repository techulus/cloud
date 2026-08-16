export type PreviewEvents = {
	"preview/sync-requested": {
		data: {
			baseServiceId: string;
			pullRequestNumber: number;
			force?: boolean;
		};
	};
	"preview/close-requested": {
		data: {
			baseServiceId: string;
			pullRequestNumber: number;
			reason: string;
			verifyWithGitHub?: boolean;
		};
	};
	"preview/service-reconcile-requested": {
		data: {
			baseServiceId: string;
		};
	};
};
