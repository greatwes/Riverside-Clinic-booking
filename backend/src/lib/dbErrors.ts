/**
 * Postgres unique_violation error code. Real `pg` always reports it as the
 * string "23505"; pg-mem (used in tests) reports the numeric literal 23505,
 * so both are accepted here.
 */
export function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("code" in err)) return false;
  const code = (err as { code?: unknown }).code;
  return code === "23505" || code === 23505;
}
