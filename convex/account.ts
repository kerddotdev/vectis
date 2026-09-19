import { mutation } from "./_generated/server.js";
import { human } from "./auth.js";
import { purgeOwner } from "./purge.js";

// Deleting an account removes everything Vectis holds for it. Sign-in data lives with Clerk, so the
// caller deletes the Clerk user afterwards; the Clerk webhook purges again if that happens first.
export const remove = mutation({
  args: {},
  handler: async (ctx) => {
    await purgeOwner(ctx, await human(ctx));
  },
});
