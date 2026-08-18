export type PreviewEvents = {
	"preview/sync-requested": {
		data: {
			baseServiceId: string;
			previewGitRef: string;
			force?: boolean;
		};
	};
	"preview/close-requested": {
		data: {
			baseServiceId: string;
			previewGitRef: string;
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
