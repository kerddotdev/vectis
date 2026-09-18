import { v } from "convex/values";
export const installation = v.object({ id: v.number(), accountId: v.number(), login: v.string() });
export const verifiedUser = v.object({
  id: v.number(),
  login: v.string(),
  installations: v.array(installation),
});
