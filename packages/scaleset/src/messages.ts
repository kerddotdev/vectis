import { Option, Schema, SchemaIssue, SchemaTransformation } from "effect";

export const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const Identifier = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
export const SessionId = Schema.String.check(Schema.isUUID());

export const Statistics = Schema.Struct({
  totalAssignedJobs: Count,
  totalAvailableJobs: Schema.optionalKey(Count),
  totalAcquiredJobs: Schema.optionalKey(Count),
  totalRunningJobs: Schema.optionalKey(Count),
  totalRegisteredRunners: Schema.optionalKey(Count),
  totalBusyRunners: Schema.optionalKey(Count),
  totalIdleRunners: Schema.optionalKey(Count),
});
export type Statistics = typeof Statistics.Type;

export const Session = Schema.Struct({
  sessionId: SessionId,
  ownerName: Schema.optionalKey(Schema.String),
  messageQueueUrl: Schema.NonEmptyString,
  messageQueueAccessToken: Schema.NonEmptyString,
  statistics: Statistics,
});
export type Session = typeof Session.Type;

const RequestId = Schema.optionalKey(Count).pipe(
  Schema.decodeTo(
    Schema.optionalKey(Identifier),
    SchemaTransformation.transformOptional({
      decode: Option.filter((id) => id !== 0),
      encode: (id) => id,
    }),
  ),
);
const Timestamp = Schema.optionalKey(Schema.String).pipe(
  Schema.decodeTo(
    Schema.optionalKey(Schema.String),
    SchemaTransformation.transformOptional({
      decode: Option.filter((value) => !/^0001-01-01T00:00:00(?:\.0+)?Z$/.test(value)),
      encode: (value) => value,
    }),
  ),
);
const job = {
  runnerRequestId: RequestId,
  repositoryName: Schema.optionalKey(Schema.String),
  ownerName: Schema.optionalKey(Schema.String),
  jobId: Schema.optionalKey(Schema.String),
  jobWorkflowRef: Schema.optionalKey(Schema.String),
  jobDisplayName: Schema.optionalKey(Schema.String),
  workflowRunId: Schema.optionalKey(Identifier),
  eventName: Schema.optionalKey(Schema.String),
  requestLabels: Schema.optionalKey(Schema.Array(Schema.String)),
  queueTime: Timestamp,
  scaleSetAssignTime: Timestamp,
  runnerAssignTime: Timestamp,
  finishTime: Timestamp,
};

const KnownJobMessage = Schema.Union([
  Schema.Struct({
    ...job,
    messageType: Schema.Literal("JobAvailable"),
    acquireJobUrl: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ ...job, messageType: Schema.Literal("JobAssigned") }),
  Schema.Struct({
    ...job,
    messageType: Schema.Literal("JobStarted"),
    runnerId: Identifier,
    runnerName: Schema.NonEmptyString,
  }),
  Schema.Struct({
    ...job,
    messageType: Schema.Literal("JobCompleted"),
    runnerId: Schema.optionalKey(Count),
    runnerName: Schema.optionalKey(Schema.String),
    result: Schema.NonEmptyString,
  }),
]);
const UnknownJobMessage = Schema.Struct({
  messageType: Schema.Literal("unknown"),
  originalMessageType: Schema.String,
});
export const JobMessage = Schema.Union([KnownJobMessage, UnknownJobMessage]);
export type JobMessage = typeof JobMessage.Type;
const knownMessageTypes = new Set(["JobAvailable", "JobAssigned", "JobStarted", "JobCompleted"]);
const MessageType = Schema.Struct({ messageType: Schema.String });

const Envelope = Schema.Struct({
  messageId: Count,
  messageType: Schema.Literal("RunnerScaleSetJobMessages"),
  body: Schema.String,
  statistics: Statistics,
});
const Batch = Schema.Array(Schema.Unknown).check(Schema.isMaxLength(50));

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1({
  // Never include rejected values or upstream error text in credential-safe diagnostics.
  leafHook: (issue) =>
    issue._tag === "MissingKey" ? "Missing required field." : "Invalid field type or value.",
  checkHook: () => "Value does not satisfy the field constraints.",
});

export class ScaleSetProtocolError extends Error {
  constructor(
    readonly issues: ReadonlyArray<{ path: string; message: string }> = [
      { path: "$", message: "Invalid or unsupported scale set response." },
    ],
  ) {
    super("Invalid or unsupported scale set response.");
    this.name = "ScaleSetProtocolError";
  }
}

function decode<S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  input: unknown,
  path = "$",
): S["Type"] {
  try {
    return Schema.decodeUnknownSync(schema)(input);
  } catch (error) {
    if (Schema.isSchemaError(error))
      throw new ScaleSetProtocolError(
        formatIssue(error.issue).issues.map((issue) => ({
          path: `${path}${(issue.path ?? []).map((key) => (typeof key === "number" ? `[${key}]` : `.${String(key)}`)).join("")}`,
          message: issue.message,
        })),
      );
    throw new ScaleSetProtocolError();
  }
}

export function decodeMessage(input: unknown) {
  const envelope = decode(Envelope, input);
  let body: unknown;
  try {
    body = envelope.body === "" ? [] : JSON.parse(envelope.body);
  } catch {
    throw new ScaleSetProtocolError([{ path: "$.body", message: "Invalid JSON message batch." }]);
  }
  const jobs = decode(Batch, body, "$.body").map((input, index): JobMessage => {
    const path = `$.body[${index}]`;
    const { messageType } = decode(MessageType, input, path);
    return knownMessageTypes.has(messageType)
      ? decode(KnownJobMessage, input, path)
      : { messageType: "unknown", originalMessageType: messageType };
  });
  return { messageId: envelope.messageId, statistics: envelope.statistics, jobs };
}
export type Message = ReturnType<typeof decodeMessage>;
