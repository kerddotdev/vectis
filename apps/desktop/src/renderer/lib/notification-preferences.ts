import { Schema } from "effect";
import { request } from "@/state";

export async function getNotificationsEnabled() {
  return Schema.decodeUnknownSync(Schema.Boolean)(await request("notifications.get"));
}

export async function setNotificationsEnabled(enabled: boolean) {
  return Schema.decodeUnknownSync(Schema.Boolean)(await request("notifications.set", enabled));
}
