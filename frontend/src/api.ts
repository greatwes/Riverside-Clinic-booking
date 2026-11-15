const BASE_URL = import.meta.env.VITE_API_BASE_URL.replace(/\/$/, "");
const API_KEY = import.meta.env.VITE_API_KEY;

export interface Slot {
  id: string;
  provider: string;
  start: string;
  end: string;
  available: boolean;
}

export interface Booking {
  id: string;
  slot_id: string;
  name: string;
  email: string;
  status: "confirmed" | "cancelled";
  created_at: string;
  provider?: string;
  appointment_start?: string;
  appointment_end?: string;
}

export class ApiError extends Error {
  status: number;
  retryAfterSeconds?: number;

  constructor(status: number, message: string, retryAfterSeconds?: number) {
    super(message);
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "X-API-Key": API_KEY,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  if (!res.ok) {
    let message = `Request failed with status ${res.status}`;
    try {
      const body = await res.json();
      if (body && typeof body.error === "string") message = body.error;
    } catch {
      // ignore: non-JSON error body
    }
    const retryAfterHeader = res.headers.get("Retry-After");
    const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined;
    throw new ApiError(res.status, message, retryAfterSeconds);
  }

  if (res.status === 200 && res.headers.get("content-length") === "0") {
    return undefined as T;
  }
  return (await res.json()) as T;
}

export function listSlots(provider?: string): Promise<{ slots: Slot[] }> {
  const query = provider ? `?provider=${encodeURIComponent(provider)}` : "";
  return request(`/slots${query}`);
}

export function createBooking(
  payload: { slot_id: string; name: string; email: string },
  idempotencyKey: string,
): Promise<Booking> {
  return request("/bookings", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "Idempotency-Key": idempotencyKey },
  });
}

export function getBooking(id: string): Promise<Booking> {
  return request(`/bookings/${encodeURIComponent(id)}`);
}

export function cancelBooking(id: string): Promise<Booking> {
  return request(`/bookings/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function listBookings(
  email: string,
  cursor?: string,
  limit = 10,
): Promise<{ bookings: Booking[]; next_cursor: string | null }> {
  const params = new URLSearchParams({ email, limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  return request(`/bookings?${params.toString()}`);
}
