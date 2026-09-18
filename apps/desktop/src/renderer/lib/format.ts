export function formatMemory(mebibytes: number) {
  const gibibytes = mebibytes / 1024;
  return gibibytes >= 1
    ? `${Number.isInteger(gibibytes) ? gibibytes : gibibytes.toFixed(1)} GB`
    : `${mebibytes} MB`;
}

export function formatBytes(bytes: number | undefined) {
  if (bytes === undefined) return "Unavailable";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function formatRelative(value: string | number, now = Date.now()) {
  const seconds = Math.round((new Date(value).getTime() - now) / 1000);
  if (Math.abs(seconds) < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return relative.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relative.format(hours, "hour");
  return relative.format(Math.round(hours / 24), "day");
}

export function formatDateTime(value: string | number) {
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
