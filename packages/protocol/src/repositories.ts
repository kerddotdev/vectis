import { Schema } from "effect";
import { Identifier } from "./index.js";
export const MachineRepositories = Schema.Array(
  Schema.Struct({
    id: Schema.NonEmptyString,
    repositoryId: Schema.Int,
    repositoryName: Schema.NonEmptyString,
    environmentId: Identifier,
    automatic: Schema.optional(Schema.Boolean),
  }),
);
export type MachineRepositories = typeof MachineRepositories.Type;
