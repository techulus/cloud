export interface Machine {
	id: string;
	name: string;
	state: string;
	region: string;
	created_at: string;
	private_ip: string;
	updated_at: string;
	host_status: string;
	instance_id: string;
	config: Config;
	events: Event[];
	image_ref: ImageRef;
	incomplete_config: Record<string, unknown>;
}

export interface Config {
	image: string;
	guest: Guest;
	restart: Restart;
}

export interface Guest {
	cpus: number;
	cpu_kind: string;
	memory_mb: number;
}

export interface Restart {
	policy: string;
	max_retries: number;
}

export interface Event {
	id: string;
	type: string;
	source: string;
	status: string;
	timestamp: number;
	request?: Request;
}

export interface Request {
	restart_count?: number;
	exit_event?: ExitEvent;
	gpu_spot_price?: number;
}

export interface ExitEvent {
	error: string;
	signal: number;
	exit_code: number;
	exited_at: string;
	oom_killed: boolean;
	restarting: boolean;
	guest_error: string;
	guest_signal: number;
	requested_stop: boolean;
	guest_exit_code: number;
}

export interface ImageRef {
	tag: string;
	digest: string;
	labels: Record<string, string>;
	registry: string;
	repository: string;
}
