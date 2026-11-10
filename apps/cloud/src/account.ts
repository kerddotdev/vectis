import type { AccountOverview } from "../../../packages/protocol/src/cloud.js";
import {
  notImplemented,
  type HumanContext,
  type HumanHandler,
  type RawHandler,
} from "./context.js";

export async function overview(_c: HumanContext): Promise<AccountOverview> {
  return notImplemented();
}
export const removeAccount: HumanHandler<"/account/remove"> = async () => notImplemented();
// POST /clerk/webhook: purges the owner when Clerk deletes the user.
export const clerkWebhook: RawHandler = async () => notImplemented();
