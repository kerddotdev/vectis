import type { Id } from "./_generated/dataModel.js";
import type { QueryCtx } from "./_generated/server.js";

export const onlineWindow = 90000;

export function presence(ctx: Pick<QueryCtx, "db">, machineId: Id<"machines">) {
  return ctx.db
    .query("machinePresence")
    .withIndex("by_machine", (q) => q.eq("machineId", machineId))
    .unique();
}
