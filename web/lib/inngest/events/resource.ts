export type ResourceEvents = {
	"resource/status-changed": {
		data: {
			type:
				| "deployment"
				| "rollout"
				| "backup"
				| "restore"
				| "build"
				| "workItem"
				| "server"
				| "service";
			id: string;
			parentType?:
				| "deployment"
				| "rollout"
				| "backup"
				| "restore"
				| "build"
				| "workItem"
				| "server"
				| "service";
			parentId?: string;
		};
	};
};
