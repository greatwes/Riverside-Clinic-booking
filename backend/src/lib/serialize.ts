export interface BookingRow {
  id: string;
  slotId: string;
  name: string;
  email: string;
  status: "confirmed" | "cancelled";
  createdAt: Date;
}

export function serializeBooking(row: BookingRow) {
  return {
    id: row.id,
    slot_id: row.slotId,
    name: row.name,
    email: row.email,
    status: row.status,
    created_at: row.createdAt.toISOString(),
  };
}
