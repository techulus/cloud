import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const where = vi.fn().mockResolvedValue({ rowCount: 3 });
	const deleteCommand = vi.fn(() => ({ where }));
	return {
		db: { delete: deleteCommand },
		deleteCommand,
		where,
		subtractMilliseconds: vi.fn(),
	};
});

vi.mock("@/db", () => ({ db: mocks.db }));
vi.mock("@/lib/date", () => ({
	DAY_IN_MILLISECONDS: 86_400_000,
	subtractMilliseconds: mocks.subtractMilliseconds,
}));

import { serviceCommands } from "@/db/schema";
import {
	cleanupOldServiceCommands,
	COMMAND_RETENTION_DAYS,
} from "@/lib/service-command-retention";

describe("service command retention", () => {
	beforeEach(() => {
		mocks.deleteCommand.mockClear();
		mocks.where.mockClear();
		mocks.where.mockResolvedValue({ rowCount: 3 });
		mocks.subtractMilliseconds.mockReset();
		mocks.subtractMilliseconds.mockReturnValue(
			new Date("2026-05-07T00:00:00Z"),
		);
	});

	it("deletes commands older than 90 days", async () => {
		const now = new Date("2026-08-05T00:00:00Z");

		const deleted = await cleanupOldServiceCommands(now);

		expect(COMMAND_RETENTION_DAYS).toBe(90);
		expect(mocks.subtractMilliseconds).toHaveBeenCalledWith(
			now,
			90 * 86_400_000,
		);
		expect(mocks.deleteCommand).toHaveBeenCalledWith(serviceCommands);
		expect(deleted).toBe(3);
		expect(mocks.where.mock.results[0]?.value).not.toHaveProperty("returning");
	});
});
