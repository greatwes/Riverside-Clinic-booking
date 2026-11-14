import { createHash } from "node:crypto";

/** Canonicalizes the request body (sorted keys) before hashing, so key order never matters. */
export function hashRequestBody(body: unknown): string {
  return createHash("sha256").update(canonicalize(body)).digest("hex");
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`,
  );
  return `{${entries.join(",")}}`;
}
