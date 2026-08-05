import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const returning = vi.fn().mockResolvedValue([{ id: "command-1" }]);
	const where = vi.fn(() => ({ returning }));
	const deleteCommand = vi.fn(() => ({ where }));
	return {
		db: { delete: deleteCommand },
		deleteCommand,
		where,
		returning,
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
		mocks.returning.mockClear();
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
		expect(deleted).toEqual([{ id: "command-1" }]);
	});
});
