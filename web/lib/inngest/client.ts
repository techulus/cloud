import { EventSchemas, Inngest } from "inngest";
import type { Events } from "./events";

export const inngest = new Inngest({
	id: "techulus-cloud",
	schemas: new EventSchemas().fromRecord<Events>(),
});
