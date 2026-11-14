import "./style.css";
import {
  ApiError,
  cancelBooking,
  createBooking,
  listBookings,
  listSlots,
  type Booking,
  type Slot,
} from "./api.js";

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} in the page`);
  return el as T;
}

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const dayLabelFormatter = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

function formatSlotTime(slot: Slot): string {
  return `${dateFormatter.format(new Date(slot.start))} – ${new Date(slot.end).toLocaleTimeString(
    undefined,
    { hour: "numeric", minute: "2-digit" },
  )}`;
}

/** Local calendar-day key (YYYY-MM-DD) for grouping slots by date, independent of time-of-day. */
function dateKeyFor(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function showError(el: HTMLElement, message: string) {
  el.textContent = message;
  el.hidden = false;
}

function hideError(el: HTMLElement) {
  el.hidden = true;
  el.textContent = "";
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) {
      const wait = err.retryAfterSeconds ? ` Try again in ${err.retryAfterSeconds}s.` : "";
      return `Too many attempts. Please slow down.${wait}`;
    }
    return err.message;
  }
  return "Something went wrong. Please try again.";
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

/* ------------------------------------------------------------------ */
/* Booking dialog: doctor -> date & time -> details -> confirmation,   */
/* mirroring the Nisa Premier Hospital booking modal's step order.     */
/* ------------------------------------------------------------------ */

type DialogStep = "doctor" | "datetime" | "details" | "confirmation";
const STEP_ORDER: DialogStep[] = ["doctor", "datetime", "details"];
const STEP_TITLES: Record<DialogStep, string> = {
  doctor: "Choose a doctor",
  datetime: "Pick a date and time",
  details: "Your details",
  confirmation: "Booking confirmed",
};

const bookingDialog = byId<HTMLDialogElement>("booking-dialog");
const dialogTitle = byId<HTMLHeadingElement>("dialog-title");
const dialogCloseBtn = byId<HTMLButtonElement>("dialog-close-btn");
const dialogProgressSteps = Array.from(
  bookingDialog.querySelectorAll<HTMLElement>(".dialog-progress-step"),
);
const dialogPanels = Array.from(bookingDialog.querySelectorAll<HTMLElement>(".dialog-panel"));
const dialogFooter = byId<HTMLDivElement>("dialog-footer");
const dialogBackBtn = byId<HTMLButtonElement>("dialog-back-btn");
const dialogSubmitBtn = byId<HTMLButtonElement>("dialog-submit-btn");

const dialogDoctorList = byId<HTMLDivElement>("dialog-doctor-list");
const dialogDoctorSummary = byId<HTMLParagraphElement>("dialog-doctor-summary");
const dialogStatus = byId<HTMLDivElement>("dialog-status");
const dialogDateTabs = byId<HTMLDivElement>("dialog-date-tabs");
const dialogTimeGrid = byId<HTMLDivElement>("dialog-time-grid");

const dialogDetailsSummary = byId<HTMLDivElement>("dialog-details-summary");
const dialogBookingForm = byId<HTMLFormElement>("dialog-booking-form");
const dialogNameInput = byId<HTMLInputElement>("dialog-patient-name");
const dialogEmailInput = byId<HTMLInputElement>("dialog-patient-email");
const dialogBookingError = byId<HTMLDivElement>("dialog-booking-error");

const dialogConfId = byId<HTMLElement>("dialog-conf-id");
const dialogConfProvider = byId<HTMLElement>("dialog-conf-provider");
const dialogConfWhen = byId<HTMLElement>("dialog-conf-when");
const dialogConfName = byId<HTMLElement>("dialog-conf-name");
const dialogConfEmail = byId<HTMLElement>("dialog-conf-email");
const dialogConfStatus = byId<HTMLElement>("dialog-conf-status");
const dialogConfirmCancelBtn = byId<HTMLButtonElement>("dialog-confirm-cancel");
const dialogBookAnotherBtn = byId<HTMLButtonElement>("dialog-book-another");

let dialogStep: DialogStep = "doctor";
let dialogProvider: string | null = null;
let dialogAvailableSlots: Slot[] = [];
let dialogSelectedDateKey: string | null = null;
let dialogSelectedSlot: Slot | null = null;
let dialogIdempotencyKey = crypto.randomUUID();

function goToDialogStep(step: DialogStep) {
  dialogStep = step;
  dialogTitle.textContent = STEP_TITLES[step];

  for (const panel of dialogPanels) {
    panel.hidden = panel.dataset.panel !== step;
  }

  const currentIndex = step === "confirmation" ? STEP_ORDER.length : STEP_ORDER.indexOf(step);
  dialogProgressSteps.forEach((el, i) => {
    el.classList.toggle("active", i === currentIndex);
    el.classList.toggle("done", i < currentIndex);
  });

  dialogFooter.hidden = step === "confirmation";
  dialogBackBtn.hidden = step === "doctor";
  dialogSubmitBtn.hidden = step !== "details";

  // Render fresh every time step 1 is shown, not just on first open: the
  // doctor-card shortcut skips straight to step 2, so "Back" from there
  // lands on step 1 without ever having rendered this list otherwise.
  if (step === "doctor") {
    renderDoctorList();
  }
}

function renderDoctorList() {
  dialogDoctorList.innerHTML = "";
  const cards = document.querySelectorAll<HTMLElement>(".doctor-card");
  for (const card of cards) {
    const name = card.querySelector("h3")?.textContent?.trim() ?? "";
    const specialty = card.querySelector(".doctor-specialty")?.textContent?.trim() ?? "";
    const imgSrc = card.querySelector("img")?.getAttribute("src") ?? "";

    const row = document.createElement("button");
    row.type = "button";
    row.className = "dialog-doctor-row";
    row.innerHTML = `
      <img src="${imgSrc}" alt="" width="48" height="48" />
      <span class="dialog-doctor-row-text"><strong>${escapeHtml(name)}</strong><span>${escapeHtml(specialty)}</span></span>
    `;
    row.addEventListener("click", () => chooseDoctor(name));
    dialogDoctorList.appendChild(row);
  }
}

function chooseDoctor(provider: string) {
  dialogProvider = provider;
  dialogDoctorSummary.textContent = provider;
  goToDialogStep("datetime");
  void loadDialogSlots();
}

async function loadDialogSlots() {
  if (!dialogProvider) return;
  dialogStatus.textContent = "Loading available times…";
  dialogDateTabs.innerHTML = "";
  dialogTimeGrid.innerHTML = "";
  dialogSelectedDateKey = null;

  try {
    const { slots } = await listSlots(dialogProvider);
    dialogAvailableSlots = slots.filter((s) => s.available);

    if (dialogAvailableSlots.length === 0) {
      dialogStatus.textContent = "No available slots for this doctor right now. Please check back later.";
      return;
    }
    dialogStatus.textContent = "";

    const dateKeys = Array.from(new Set(dialogAvailableSlots.map((s) => dateKeyFor(s.start)))).sort();
    dialogSelectedDateKey = dateKeys[0];
    renderDialogDateTabs(dateKeys);
    renderDialogTimeGrid();
  } catch (err) {
    dialogStatus.textContent = describeError(err);
  }
}

function renderDialogDateTabs(dateKeys: string[]) {
  dialogDateTabs.innerHTML = "";
  for (const key of dateKeys) {
    const date = new Date(`${key}T00:00:00`);
    const isActive = key === dialogSelectedDateKey;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "date-tab" + (isActive ? " active" : "");
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", String(isActive));
    btn.innerHTML = `<span class="date-tab-day">${dayLabelFormatter.format(date)}</span><span class="date-tab-num">${date.getDate()}</span>`;
    btn.addEventListener("click", () => {
      dialogSelectedDateKey = key;
      renderDialogDateTabs(dateKeys);
      renderDialogTimeGrid();
    });
    dialogDateTabs.appendChild(btn);
  }
}

function renderDialogTimeGrid() {
  dialogTimeGrid.innerHTML = "";
  if (!dialogSelectedDateKey) return;

  const daySlots = dialogAvailableSlots
    .filter((s) => dateKeyFor(s.start) === dialogSelectedDateKey)
    .sort((a, b) => a.start.localeCompare(b.start));

  for (const slot of daySlots) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "time-slot";
    btn.textContent = timeFormatter.format(new Date(slot.start));
    btn.addEventListener("click", () => chooseDialogSlot(slot));
    dialogTimeGrid.appendChild(btn);
  }
}

function chooseDialogSlot(slot: Slot) {
  dialogSelectedSlot = slot;
  dialogIdempotencyKey = crypto.randomUUID();
  dialogDetailsSummary.textContent = `${slot.provider} · ${formatSlotTime(slot)}`;
  hideError(dialogBookingError);
  goToDialogStep("details");
}

dialogBookingForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!dialogSelectedSlot) return;

  hideError(dialogBookingError);
  dialogSubmitBtn.disabled = true;
  dialogSubmitBtn.textContent = "Booking…";

  try {
    const booking = await createBooking(
      { slot_id: dialogSelectedSlot.id, name: dialogNameInput.value, email: dialogEmailInput.value },
      dialogIdempotencyKey,
    );
    showDialogConfirmation(booking, dialogSelectedSlot);
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      showError(dialogBookingError, "That slot was just booked by someone else. Pick another time.");
      goToDialogStep("datetime");
      await loadDialogSlots();
    } else {
      showError(dialogBookingError, describeError(err));
    }
  } finally {
    dialogSubmitBtn.disabled = false;
    dialogSubmitBtn.textContent = "Book this slot";
  }
});

function showDialogConfirmation(booking: Booking, slot: Slot) {
  dialogConfId.textContent = booking.id;
  dialogConfProvider.textContent = slot.provider;
  dialogConfWhen.textContent = formatSlotTime(slot);
  dialogConfName.textContent = booking.name;
  dialogConfEmail.textContent = booking.email;
  dialogConfStatus.textContent = booking.status;
  dialogConfirmCancelBtn.hidden = booking.status === "cancelled";
  dialogConfirmCancelBtn.dataset.bookingId = booking.id;
  goToDialogStep("confirmation");
}

dialogConfirmCancelBtn.addEventListener("click", async () => {
  const id = dialogConfirmCancelBtn.dataset.bookingId;
  if (!id) return;
  dialogConfirmCancelBtn.disabled = true;
  try {
    const cancelled = await cancelBooking(id);
    dialogConfStatus.textContent = cancelled.status;
    dialogConfirmCancelBtn.hidden = true;
  } catch (err) {
    alert(describeError(err));
  } finally {
    dialogConfirmCancelBtn.disabled = false;
  }
});

dialogBookAnotherBtn.addEventListener("click", () => {
  dialogProvider = null;
  dialogSelectedSlot = null;
  dialogBookingForm.reset();
  goToDialogStep("doctor");
});

dialogBackBtn.addEventListener("click", () => {
  if (dialogStep === "datetime") {
    goToDialogStep("doctor");
  } else if (dialogStep === "details") {
    goToDialogStep("datetime");
  }
});

function openBookingDialog(initialProvider?: string) {
  hideError(dialogBookingError);
  dialogBookingForm.reset();
  dialogSelectedSlot = null;

  if (initialProvider) {
    chooseDoctor(initialProvider);
  } else {
    dialogProvider = null;
    goToDialogStep("doctor");
  }

  bookingDialog.showModal();
}

dialogCloseBtn.addEventListener("click", () => bookingDialog.close());

// Clicking the backdrop (a click landing on the <dialog> element itself,
// outside its content box) closes it, same as the "X" button.
bookingDialog.addEventListener("click", (event) => {
  if (event.target === bookingDialog) {
    bookingDialog.close();
  }
});

for (const btn of document.querySelectorAll<HTMLButtonElement>(".open-booking-dialog")) {
  btn.addEventListener("click", () => openBookingDialog());
}

for (const btn of document.querySelectorAll<HTMLButtonElement>(".doctor-book-btn")) {
  btn.addEventListener("click", () => {
    const provider = btn.dataset.provider ?? "";
    openBookingDialog(provider);
  });
}

/* ------------------------------------------------------------------ */
/* Header: mobile nav + theme toggle                                   */
/* ------------------------------------------------------------------ */

const navToggle = document.getElementById("nav-toggle") as HTMLInputElement | null;
if (navToggle) {
  for (const link of document.querySelectorAll<HTMLAnchorElement>(".main-nav a")) {
    link.addEventListener("click", () => {
      navToggle.checked = false;
    });
  }
}

// Theme toggle. The inline script in <head> already applies the stored/system
// theme before first paint (to avoid a flash); this just lets the user flip it.
const themeToggle = document.getElementById("theme-toggle") as HTMLButtonElement | null;
if (themeToggle) {
  const root = document.documentElement;

  const syncButton = (theme: string) => {
    themeToggle.setAttribute("aria-pressed", String(theme === "dark"));
    themeToggle.setAttribute(
      "aria-label",
      theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
    );
  };
  syncButton(root.getAttribute("data-theme") ?? "light");

  themeToggle.addEventListener("click", () => {
    const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    syncButton(next);
    try {
      localStorage.setItem("theme", next);
    } catch {
      // localStorage unavailable (private browsing, etc.); theme just won't persist.
    }
  });
}

/* ------------------------------------------------------------------ */
/* Lookup an existing patient's bookings                               */
/* ------------------------------------------------------------------ */

const lookupForm = byId<HTMLFormElement>("lookup-form");
const lookupEmailInput = byId<HTMLInputElement>("lookup-email");
const lookupStatus = byId<HTMLDivElement>("lookup-status");
const bookingsTable = byId<HTMLTableElement>("bookings-table");
const bookingsTableBody = byId<HTMLTableSectionElement>("bookings-table-body");
const loadMoreBtn = byId<HTMLButtonElement>("load-more-bookings");

let lookupEmail = "";
let lookupCursor: string | null = null;

lookupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  lookupEmail = lookupEmailInput.value.trim();
  lookupCursor = null;
  bookingsTableBody.innerHTML = "";
  await loadBookingsPage();
});

loadMoreBtn.addEventListener("click", loadBookingsPage);

async function loadBookingsPage() {
  if (!lookupEmail) return;
  lookupStatus.textContent = "Loading…";
  try {
    const { bookings, next_cursor } = await listBookings(lookupEmail, lookupCursor ?? undefined);
    if (bookings.length === 0 && bookingsTableBody.children.length === 0) {
      bookingsTable.hidden = true;
      lookupStatus.textContent = "No bookings found for that email.";
      loadMoreBtn.hidden = true;
      return;
    }
    bookingsTable.hidden = false;
    lookupStatus.textContent = "";
    for (const booking of bookings) {
      bookingsTableBody.appendChild(renderBookingRow(booking));
    }
    lookupCursor = next_cursor;
    loadMoreBtn.hidden = lookupCursor === null;
  } catch (err) {
    lookupStatus.textContent = describeError(err);
  }
}

function renderBookingRow(booking: Booking): HTMLTableRowElement {
  const row = document.createElement("tr");

  const idCell = document.createElement("td");
  idCell.textContent = booking.id;

  const statusCell = document.createElement("td");
  const badge = document.createElement("span");
  badge.className = `status-badge status-${booking.status}`;
  badge.textContent = booking.status;
  statusCell.appendChild(badge);

  const createdCell = document.createElement("td");
  createdCell.textContent = new Date(booking.created_at).toLocaleString();

  const actionCell = document.createElement("td");
  if (booking.status === "confirmed") {
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn btn-text btn-small";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", async () => {
      cancelBtn.disabled = true;
      try {
        const updated = await cancelBooking(booking.id);
        badge.className = `status-badge status-${updated.status}`;
        badge.textContent = updated.status;
        actionCell.innerHTML = "";
      } catch (err) {
        alert(describeError(err));
        cancelBtn.disabled = false;
      }
    });
    actionCell.appendChild(cancelBtn);
  }

  row.append(idCell, statusCell, createdCell, actionCell);
  return row;
}
