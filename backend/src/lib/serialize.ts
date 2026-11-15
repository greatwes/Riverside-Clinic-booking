export interface BookingRow {
  id: string;
  slotId: string;
  name: string;
  email: string;
  status: "confirmed" | "cancelled";
  createdAt: Date;
}

export interface SlotSummary {
  provider: string;
  start: Date;
  end: Date;
}

export function serializeBooking(row: BookingRow, slot?: SlotSummary) {
  return {
    id: row.id,
    slot_id: row.slotId,
    name: row.name,
    email: row.email,
    status: row.status,
    created_at: row.createdAt.toISOString(),
    ...(slot
      ? {
          provider: slot.provider,
          appointment_start: slot.start.toISOString(),
          appointment_end: slot.end.toISOString(),
        }
      : {}),
  };
}
