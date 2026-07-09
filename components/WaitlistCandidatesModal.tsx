"use client";

/* ===== RadFlow — Кандидати з листа очікування на слот, що звільнився =====
   Показується після скасування/відмови: пацієнти зі статусом waiting, чиє
   бажане вікно (дати/час/модальність) покриває звільнений слот. «Записати»
   відкриває повну модалку запису з передзаповненням (той самий флоу, що
   /waitlist). Та сама логіка матчингу піде в n8n/AI-автоматизацію (Stage 2). */

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import BookingModal, { type BookingPayload, type BookingPrefill } from "@/components/BookingModal";
import { createBooking } from "@/app/queue/actions";
import { markWaitlistScheduled } from "@/app/waitlist/actions";
import { waitlistMatchesSlot, compareWaitlist, desiredWindowText, timeToMin } from "@/lib/waitlist";
import { PRIORITY_META } from "@/lib/priority";
import type { Modality, WaitlistEntry } from "@/supabase/types";
import type { Study } from "@/lib/studies";
import { useModalA11y } from "@/lib/useModalA11y";

type RoomOpt = { id: string; modality: string; name: string; apparatus_model?: string | null };
type IncidentLite = { id: string; room_id: string; reason_label?: string | null; note?: string | null; started_at: string; blocked_until: string | null; status: string };

export type FreedSlotInfo = {
  date: string; // YYYY-MM-DD — дата звільненого слота
  time: string | null; // HH:MM
  roomId: string | null;
};

function studiesLabel(e: WaitlistEntry): string {
  const s = Array.isArray(e.studies) ? (e.studies as Study[]) : [];
  if (!s.length) return "—";
  return s.map((x) => (x.type || "") + (x.region ? " · " + x.region : "") + (x.contrast ? " з контрастом" : "")).join(" + ");
}

/** Підібрати кандидатів з листа під звільнений слот (для рішення «показувати чи ні»).
    Слоти в минулому не пропонуємо. */
export async function fetchWaitlistCandidates(
  clinicId: string,
  slot: FreedSlotInfo,
  rooms?: RoomOpt[]
): Promise<WaitlistEntry[]> {
  try {
    if (!slot.date || !slot.time) return [];
    const now = new Date();
    const todayKey = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
    const timeMin = timeToMin(slot.time) ?? 0;
    if (slot.date < todayKey) return [];
    if (slot.date === todayKey && timeMin <= now.getHours() * 60 + now.getMinutes()) return [];
    const modality = (rooms || []).find((r) => r.id === slot.roomId)?.modality as Modality | undefined;

    const supabase = createClient();
    const { data } = await supabase
      .from("waitlist_entries")
      .select("*")
      .eq("clinic_id", clinicId)
      .eq("status", "waiting");
    return (data || [])
      .filter((e) => waitlistMatchesSlot(e, { date: slot.date, timeMin, modality: modality ?? null, roomId: slot.roomId }))
      .sort(compareWaitlist);
  } catch {
    return []; // транзієнтна помилка мережі — просто не пропонуємо
  }
}

interface WaitlistCandidatesModalProps {
  clinicId: string;
  rooms?: RoomOpt[];
  incidents?: IncidentLite[];
  slot: FreedSlotInfo;
  candidates: WaitlistEntry[];
  onClose: () => void;
  onBooked?: (msg: string) => void;
  onError?: (msg: string) => void;
}

export default function WaitlistCandidatesModal({ clinicId, rooms, incidents = [], slot, candidates, onClose, onBooked, onError }: WaitlistCandidatesModalProps) {
  const dialogRef = useModalA11y<HTMLDivElement>(onClose);
  const [bookFor, setBookFor] = useState<WaitlistEntry | null>(null);
  const roomName = (rooms || []).find((r) => r.id === slot.roomId)?.name || "кабінет";

  function dateKey(d: Date) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }

  async function saveBooking(b: BookingPayload) {
    const wl = bookFor;
    if (!wl) return;
    const [hh, mm] = b.time.split(":").map(Number);
    const at = new Date(b.date.getFullYear(), b.date.getMonth(), b.date.getDate(), hh, mm).toISOString();
    const res = await createBooking({
      roomId: b.roomId, referrerId: b.referrerId ?? (wl.referrer_id || null),
      name: b.name, phone: b.phone || null, email: b.email ?? null,
      dob: b.dob || null, sex: b.gender || null, age: b.age || null, weight: b.weight ?? null,
      hasContra: !!b.hasContra, priorityLevel: b.priority,
      studies: b.studies || [], doctor: b.doctor ?? null, notes: b.notes ?? null, durationMin: b.dur, bufferTimeMin: b.buffer,
      scheduledDate: dateKey(b.date), scheduledTime: b.time, scheduledAt: at,
    });
    if (!res.ok) {
      onError?.(res.code === "slot_taken" || res.code === "slot_unavailable"
        ? "Слот щойно зайняли — оберіть інший час"
        : res.code === "incident" ? "Кабінет у простої у цей час — оберіть інший слот"
        : "Помилка запису: " + res.error);
      return;
    }
    await markWaitlistScheduled(wl.id, res.id ?? null);
    setBookFor(null);
    onBooked?.("Записано з листа очікування: " + b.name + " · " + b.time);
    onClose();
  }

  const bookPrefill: BookingPrefill | null = bookFor ? {
    name: bookFor.patient_name, phone: bookFor.patient_phone, email: bookFor.patient_email,
    dob: bookFor.patient_dob, gender: bookFor.patient_sex, weight: bookFor.patient_weight,
    priority: bookFor.priority_level, notes: bookFor.note, buffer: bookFor.buffer_time_min,
    studies: Array.isArray(bookFor.studies) ? (bookFor.studies as Study[]) : [],
    // Одразу підставляємо вікно, що звільнилося (кабінет/дату/час) — можна змінити.
    roomId: slot.roomId, date: slot.date, time: slot.time,
  } : null;

  if (bookFor) {
    return (
      <BookingModal rooms={rooms} clinicId={clinicId} incidents={incidents} prefill={bookPrefill}
        onClose={() => setBookFor(null)} onSave={saveBooking} />
    );
  }

  return (
    <div className="overlay">
      <div className="dialog fade-in" ref={dialogRef} role="dialog" aria-modal="true" aria-label="Кандидати з листа очікування" style={{ maxWidth: 520 }}>
        <div className="dlg-head">
          <div className="dlg-title"><span className="tic">⏳</span>Слот звільнився</div>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="dlg-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="info-banner">
            <span className="ib-ic">💡</span>
            <span className="ib-txt">
              Звільнилося вікно <b>{slot.date.split("-").reverse().slice(0, 2).join(".")} о {slot.time}</b> ({roomName}).
              У листі очікування є {candidates.length === 1 ? "підходящий пацієнт" : "підходящі пацієнти"} — можна записати одразу.
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {candidates.map((p) => {
              const m = PRIORITY_META[p.priority_level];
              return (
                <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--r-md)", padding: "9px 12px" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
                      {p.priority_level !== "planned" && <span className={"prio-tag " + m.tone}>{m.short}</span>}
                      <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.patient_name}</span>
                    </div>
                    <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {studiesLabel(p)} · {desiredWindowText(p)}{p.patient_phone ? " · " + p.patient_phone : ""}
                    </div>
                  </div>
                  <button className="btn btn-green btn-sm" style={{ flexShrink: 0 }} onClick={() => setBookFor(p)}>🗓 Записати</button>
                </div>
              );
            })}
          </div>
        </div>
        <div className="dlg-foot">
          <span className="bk-summary">Пріоритет: CITO → Терміново → Планово</span>
          <button className="btn btn-ghost" onClick={onClose}>Пізніше</button>
        </div>
      </div>
    </div>
  );
}
