import { Buffer } from "node:buffer";

const replacement = "[redacted]";
const pemMarker = /-----((?:BEGIN|END) (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY)-----/g;

function privateKeys(text: string) {
  const parts: string[] = [];
  let copied = 0;
  let begin: number | undefined;
  for (const marker of text.matchAll(pemMarker)) {
    if (marker[1]?.startsWith("BEGIN")) begin ??= marker.index;
    else {
      // An unmatched END may belong to a key that started before a bounded log tail.
      const start = begin ?? copied;
      parts.push(text.slice(copied, start), replacement);
      copied = marker.index + marker[0].length;
      begin = undefined;
    }
  }
  if (begin !== undefined) parts.push(text.slice(copied, begin), replacement);
  else parts.push(text.slice(copied));
  return parts.join("");
}

function quoted(value: string) {
  const quote = value[0];
  return quote === '"' || quote === "'"
    ? quote + replacement + (value.endsWith(quote) && value.length > 1 ? quote : "")
    : replacement;
}

export function redact(text: string, secrets: readonly string[] = []): string {
  text = privateKeys(text);
  text = text.replace(
    /\b(authorization[ \t]*:[ \t]*(?:bearer|basic|token)[ \t]+)[^\s"'<>;,]+/gi,
    (_match, prefix: string) => prefix + replacement,
  );
  text = text.replace(
    /(--jitconfig(?:[ \t]+|=))("[^"\r\n]*"?|'[^'\r\n]*'?|[^\s"'<>;]+)/gi,
    (_match, prefix: string, value: string) => prefix + quoted(value),
  );
  text = text.replace(
    /([?&])([^?&#=\s"'<>]+)=([^&#\s"'<>]*)/g,
    (match, separator: string, key: string) => {
      let name;
      try {
        name = decodeURIComponent(key);
      } catch {
        name = key;
      }
      return /^(?:token|sig|signature|code|x-amz-.+)$/i.test(name)
        ? `${separator}${key}=${replacement}`
        : match;
    },
  );
  text = text.replace(
    /\b((?:password|secret|token|jitconfig)[ \t]*=[ \t]*)("[^"\r\n]*"?|'[^'\r\n]*'?|[^\s&#;,"'<>]+)/gi,
    (_match, prefix: string, value: string) => prefix + quoted(value),
  );
  text = text.replace(/(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, replacement);
  // Tokenize first so repeated eyJ prefixes cannot restart an unbounded JWT scan.
  text = text.replace(/[A-Za-z0-9_.-]+/g, (token) => {
    const segments = token.split(".");
    const result: string[] = [];
    for (let index = 0; index < segments.length; index++) {
      const header = segments[index] ?? "";
      const start = header.indexOf("eyJ");
      if (
        index + 2 < segments.length &&
        start >= 0 &&
        /^[A-Za-z0-9_-]+$/.test(segments[index + 1] ?? "") &&
        /^[A-Za-z0-9_-]+$/.test(segments[index + 2] ?? "")
      ) {
        result.push(header.slice(0, start) + replacement);
        index += 2;
      } else {
        result.push(header);
      }
    }
    return result.join(".");
  });
  // JIT configurations are base64 JSON maps of runner files, including .credentials.
  text = text.replace(/[A-Za-z0-9_+/=-]+/g, (token) => {
    if (token.length < 8) return token;
    const decoded = Buffer.from(token, "base64").toString("utf8");
    return /"(?:\.credentials(?:_rsaparams)?|encoded_jit_config)"[ \t]*:/.test(decoded)
      ? replacement
      : token;
  });
  const known = secrets.filter((secret) => secret.length >= 8);
  if (known.length) {
    const literals = [replacement, ...known]
      .toSorted((a, b) => b.length - a.length)
      .map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    text = text.replace(new RegExp(literals.join("|"), "g"), () => replacement);
  }
  return text;
}
