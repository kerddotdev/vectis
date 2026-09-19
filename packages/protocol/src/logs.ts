import { Schema } from "effect";

export const logLineLimit = 1000;
export const LogRequest = Schema.Struct({
  lines: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: logLineLimit }))),
});
export const ServiceLog = Schema.Struct({
  lines: Schema.Array(Schema.String),
  truncated: Schema.Boolean,
});
export type ServiceLog = typeof ServiceLog.Type;
