const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 5;

const attemptsByKey = new Map<string, number[]>();

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * Sliding-window log limiter: at most MAX_ATTEMPTS calls per key per WINDOW_MS,
 * counting every call (including ones that go on to fail validation). In-memory
 * is fine here per the spec; Render runs this as one long-lived process rather
 * than a cold-starting serverless function, so the window survives between requests.
 */
export function checkRateLimit(key: string, now: number = Date.now()): RateLimitResult {
  const windowStart = now - WINDOW_MS;
  const existing = (attemptsByKey.get(key) ?? []).filter((t) => t > windowStart);

  if (existing.length >= MAX_ATTEMPTS) {
    const oldest = existing[0];
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000));
    attemptsByKey.set(key, existing);
    return { allowed: false, retryAfterSeconds };
  }

  existing.push(now);
  attemptsByKey.set(key, existing);
  return { allowed: true, retryAfterSeconds: 0 };
}

/** Test-only: clears all tracked attempts so test cases don't bleed into each other. */
export function resetRateLimiter(): void {
  attemptsByKey.clear();
}
