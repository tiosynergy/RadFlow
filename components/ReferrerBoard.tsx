"use client";

/* ===== RadFlow — ReferrerBoard =====
   Доска-очередь направника: візуально та функціонально як «Дошка черги»
   адміністратора (ті самі класи .qrow, .q-*, .stats), але:
     • статус дослідження і статус обдзвону — ТІЛЬКИ ЧИТАННЯ (direved «Запізнення» теж видно);
     • мультицентр: перемикач центрів + агрегат «Всі центри»;
     • операційних панелей клініки (Поломка/ТО, Графік, завантаженість,
       керування дозвоном, кнопки прийшов/викликати/завершити) НЕМАЄ;
     • дії у місці рішення (розгорнутий рядок): перезапис, скасування,
       редагування даних пацієнта (наступні зрізи — дослідження, пріоритет, примітки).
   Захист на рівні БД: міграція 0048 (call_status read-only, status лише scheduled/cancelled). */

import { useEffect, useMemo, useState } from "react";
import MiniCalendar from "@/components/MiniCalendar";
import { PRIORITY_META, type PatientPriority } from "@/lib/priority";
import { isLate, LATE_META } from "@/lib/queueStatus";
import { wallNow } from "@/lib/incidents";
import { diffStudies, studyText, studiesChanged } from "@/lib/studies";
import type { Json } from "@/supabase/types";

type RoomOpt = { id: string; modality: string; name: string; apparatus_model?: string | null };
type Center = { clinicId: string; name: string; city: string | null; status: string; policy?: string | null; room_ids?: string[] | null; accessId?: string | null; timezone?: string | null };
export type BoardReferral = {
  id: string; clinic_id: string; created_by: string | null; referrer_id: string | null; patient_name: string | null; patient_phone: string | null; patient_age: number | null;
  scheduled_date: string | null; scheduled_time: string | null; duration_min: number | null; buffer_time_min: number | null; status: string;
  call_status: string | null; priority_level: PatientPriority | null; studies: Json; studies_original: Json | null; studies_changed_by: string | null; contraindications: boolean;
  doctor: string | null; note: string | null; indication: string | null; room_id: string | null; reschedule_origin: Json | null;
};
type RescheduleOrigin = { from_date?: string | null; from_time?: string | null; from_room?: string | null; from_status?: string | null; reason?: string | null };
function fmtOrigin(o: RescheduleOrigin | null, roomById: Record<string, RoomOpt>): string | null {
  if (!o || (!o.from_date && !o.from_time)) return null;
  const room = o.from_room ? roomById[o.from_room] : null;
  const parts = [ [o.from_date, o.from_time].filter(Boolean).join(" "), room?.name ].filter(Boolean);
  let s = "🔁 Перенесено з " + parts.join(" · ");
  if (o.reason) s += " · причина: " + o.reason;
  return s;
}

/* Статус дослідження — той самий словник, що на дошці адміна (read-only). */
const STATUS_META: Record<string, { label: string; cls: string }> = {
  scheduled: { label: "Очікує", cls: "gray" },
  waiting: { label: "В роботі", cls: "blue" },
  in_progress: { label: "В роботі", cls: "blue" },
  done: { label: "Виконано", cls: "green" },
  no_show: { label: "Неявка", cls: "red" },
  not_held: { label: "Не відбулося", cls: "gray" },
  cancelled: { label: "Скасовано", cls: "gray" },
};
/* Статус обдзвону — read-only бейдж (направник бачить, але не змінює). */
const CALL_META: Record<string, { label: string; icon: string }> = {
  confirmed: { label: "Підтверджено", icon: "✓" },
  to_recall: { label: "Передзвонити", icon: "↻" },
  no_answer: { label: "Не відповідає", icon: "…" },
  declined: { label: "Відмова", icon: "✕" },
  not_called: { label: "Не дзвонили", icon: "○" },
};
const CALL_COLOR: Record<string, string> = { confirmed: "var(--green)", to_recall: "#4da3ff", no_answer: "var(--orange)", declined: "var(--red)", not_called: "var(--text-muted)" };

/* Фільтри статусів (як окремі stat-картки). «active» = waiting+in_progress. */
const STATUS_FILTERS = [
  { key: "all", label: "Усі", match: (_s: string) => true, valCls: "white" },
  { key: "scheduled", label: "Очікує", match: (s: string) => s === "scheduled", valCls: "gray" },
  { key: "active", label: "В роботі", match: (s: string) => s === "waiting" || s === "in_progress", valCls: "blue" },
  { key: "done", label: "Виконано", match: (s: string) => s === "done", valCls: "green" },
  { key: "not_held", label: "Не відбулося", match: (s: string) => s === "not_held", valCls: "gray" },
  { key: "no_show", label: "Неявка", match: (s: string) => s === "no_show", valCls: "red" },
  { key: "cancelled", label: "Скасовано", match: (s: string) => s === "cancelled", valCls: "gray" },
] as const;

function procLabel(e: { studies?: unknown; note?: string | null }) {
  const s = Array.isArray(e.studies) ? (e.studies as Array<{ type?: string; region?: string }>) : [];
  if (s.length) return s.map((x) => (x.type || "") + (x.region ? " · " + x.region : "")).join(" + ");
  return e.note || "—";
}
function centerLabel(c?: Center | null) { return c ? c.name + (c.city ? " · " + c.city : "") : "—"; }
// tz — таймзона центру запису (мультиклінічний портал): «зараз» рахуємо по ній.
function refIsLate(r: BoardReferral, tz?: string | null): boolean {
  if (!r.scheduled_date) return false;
  return isLate(r.status, new Date(r.scheduled_date + "T00:00:00"), r.scheduled_time, r.buffer_time_min, wallNow(tz || undefined));
}
function modLabel(m?: string) { return m === "MRI" ? "МРТ" : m === "CT" ? "КТ" : ""; }

interface Props {
  referrals: BoardReferral[];
  activeCenters: Center[];
  centersById: Record<string, Center>;
  roomsByClinic: Record<string, RoomOpt[]>;
  doctorId: string;
  onReschedule: (r: BoardReferral) => void;
  onEditStudies: (r: BoardReferral) => void;
  onCancel: (r: BoardReferral) => void;
  onEditPatient: (r: BoardReferral) => void;
  /** Швидкий фільтр із сайдбару (клік по центру/кабінету). nonce → повторне застосування. */
  focus?: { clinicId: string; roomId: string; nonce: number } | null;
}

export default function ReferrerBoard({ referrals, activeCenters, centersById, roomsByClinic, doctorId, onReschedule, onEditStudies, onCancel, onEditPatient, focus }: Props) {
  const [centerId, setCenterId] = useState<string>("all"); // "all" = Всі центри
  const [roomId, setRoomId] = useState<string>("all");
  const [dateFilter, setDateFilter] = useState<string>(""); // "" = всі дати
  const [filter, setFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Швидкий фільтр із сайдбару: застосовуємо центр+кабінет (nonce → навіть повторний клік).
  useEffect(() => {
    if (!focus) return;
    setCenterId(focus.clinicId);
    setRoomId(focus.roomId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);

  const multiCenter = activeCenters.length > 1;
  // Лише ДОЗВОЛЕНІ кабінети напрямника (referral_access.room_ids). null/порожньо = усі — як у сайдбарі.
  const rooms = useMemo(() => {
    if (centerId === "all") return [];
    const all = roomsByClinic[centerId] || [];
    const allowed = centersById[centerId]?.room_ids;
    const list = Array.isArray(allowed) && allowed.length ? allowed : null;
    return list ? all.filter((r) => list.includes(r.id)) : all;
  }, [centerId, roomsByClinic, centersById]);
  const roomById = useMemo(() => {
    const m: Record<string, RoomOpt> = {};
    Object.values(roomsByClinic).forEach((arr) => arr.forEach((r) => { m[r.id] = r; }));
    return m;
  }, [roomsByClinic]);

  // Записи, звужені центром/кабінетом/датою (до статус-фільтра — щоб рахувати картки).
  const scoped = useMemo(() => referrals.filter((r) => {
    if (centerId !== "all" && r.clinic_id !== centerId) return false;
    if (roomId !== "all" && r.room_id !== roomId) return false;
    if (dateFilter && r.scheduled_date !== dateFilter) return false;
    if (query.trim()) { const q = query.trim().toLowerCase(); if (!((r.patient_name || "").toLowerCase().includes(q) || procLabel(r).toLowerCase().includes(q))) return false; }
    return true;
  }), [referrals, centerId, roomId, dateFilter, query]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    STATUS_FILTERS.forEach((f) => { c[f.key] = scoped.filter((r) => f.match(r.status)).length; });
    return c;
  }, [scoped]);

  const activeFilter = STATUS_FILTERS.find((f) => f.key === filter) || STATUS_FILTERS[0];
  const filtered = scoped.filter((r) => activeFilter.match(r.status));

  const canCancel = (r: BoardReferral) => ["scheduled", "waiting"].includes(r.status);

  function selectCenter(id: string) { setCenterId(id); setRoomId("all"); }

  // Календар як у адміна: вибір дня = фільтр за датою (порожньо = всі дати).
  const dk = (d: Date) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const calDate = dateFilter ? new Date(dateFilter + "T00:00:00") : new Date();

  return (
    <div style={{ maxWidth: 1280, margin: "0 auto", display: "grid", gridTemplateColumns: "minmax(0,1fr) 300px", gap: 16, alignItems: "start" }}>
      <div style={{ minWidth: 0 }}>
      {/* Перемикач центрів */}
      {multiCenter && (
        <div className="pills" style={{ marginBottom: 12, flexWrap: "wrap" }}>
          <button className={"pill" + (centerId === "all" ? " active" : "")} onClick={() => selectCenter("all")}>Всі центри</button>
          {activeCenters.map((c) => (
            <button key={c.clinicId} className={"pill" + (centerId === c.clinicId ? " active" : "")} onClick={() => selectCenter(c.clinicId)}>{c.name}</button>
          ))}
        </div>
      )}

      {/* Stat-картки як фільтри статусу */}
      <div className="stats" role="tablist" aria-label="Фільтр за статусом" style={{ gridTemplateColumns: "repeat(7, minmax(0, 1fr))" }}>
        {STATUS_FILTERS.map((f) => (
          <button key={f.key} role="tab" aria-selected={filter === f.key}
            className={"stat clickable" + (filter === f.key ? " active" : "")} onClick={() => setFilter(f.key)}>
            <div className="lab">{f.label}</div>
            <div className={"val tabular " + f.valCls}>{counts[f.key]}</div>
          </button>
        ))}
      </div>

      {/* Панель фільтрів: кабінет + дата + пошук */}
      <div className="qctrl" style={{ marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        {centerId !== "all" && rooms.length > 0 && (
          <select className="inp" style={{ height: 32, padding: "2px 8px", maxWidth: 240 }} value={roomId} onChange={(e) => setRoomId(e.target.value)}>
            <option value="all">Усі кабінети</option>
            {rooms.map((r) => <option key={r.id} value={r.id}>{modLabel(r.modality)} · {r.name}</option>)}
          </select>
        )}
        <div className="spacer" />
        <div className="search"><span className="si">⌕</span><input placeholder="Пошук пацієнта…" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
      </div>

      {filtered.length === 0 ? (
        <div className="empty"><div className="ei">📄</div><div className="et">Направлень немає</div><div className="es">Змініть фільтр або створіть направлення</div></div>
      ) : (
        <>
          <div className="qhead" style={{ display: "grid", gridTemplateColumns: "54px minmax(0,2fr) minmax(0,2.4fr) minmax(120px,1.2fr) 130px 26px", gap: 12, padding: "6px 16px", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-faint)" }}>
            <div>Час</div><div>Пацієнт</div><div>Дослідження</div><div>Кабінет</div><div>Статус</div><div />
          </div>
          <div className="qrows">
            {filtered.map((r) => {
              const expanded = expandedId === r.id;
              const late = refIsLate(r, centersById[r.clinic_id]?.timezone);
              const meta = late ? LATE_META : (STATUS_META[r.status] || STATUS_META.scheduled);
              const room = r.room_id ? roomById[r.room_id] : null;
              const km = room ? modLabel(room.modality) : "";
              const changed = studiesChanged(r.studies_original as Parameters<typeof studiesChanged>[0], r.studies as Parameters<typeof studiesChanged>[1]);
              const call = CALL_META[r.call_status || "not_called"];
              // Направник керує записом у ДВОХ випадках: він автор (created_by)
              // АБО його призначив центр направником запису (referrer_id).
              const owned = r.created_by === doctorId || r.referrer_id === doctorId;
              return (
                <div className={"qrow-item " + r.status + (expanded ? " open" : "")} key={r.id}>
                  <div className="qrow" role="button" tabIndex={0} style={{ gridTemplateColumns: "54px minmax(0,2fr) minmax(0,2.4fr) minmax(120px,1.2fr) 130px 26px" }}
                    onClick={() => setExpandedId((x) => (x === r.id ? null : r.id))}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpandedId((x) => (x === r.id ? null : r.id)); } }}>
                    <div className="q-time tabular">{r.scheduled_time || "—"}<div className="td">{r.duration_min ? r.duration_min + " хв" : ""}</div><div className="td" style={{ marginTop: 2, color: "var(--text-muted)" }}>{r.scheduled_date}</div></div>
                    <div className="q-pat">
                      <div className="nm">
                        {r.priority_level && r.priority_level !== "planned" && r.status !== "done" && r.status !== "cancelled" && <span className={"prio-tag " + PRIORITY_META[r.priority_level].tone}>{PRIORITY_META[r.priority_level].short}</span>}
                        {(owned && canCancel(r)) ? (
                          <span onClick={(e) => { e.stopPropagation(); onEditPatient(r); }} style={{ cursor: "pointer", textDecorationLine: "underline", textDecorationStyle: "dotted", textUnderlineOffset: 3 }} title="Редагувати дані пацієнта">{r.patient_name}</span>
                        ) : r.patient_name}
                      </div>
                      <div className="det" style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                        {r.patient_phone && <span style={{ whiteSpace: "nowrap" }}>Тел. {r.patient_phone}</span>}
                        {r.patient_age != null && <span>{r.patient_age} р.</span>}
                      </div>
                    </div>
                    <div className="q-proc">
                      <div className="pp">{procLabel(r)}{changed && <span style={{ color: "var(--orange)", marginLeft: 6 }}>✎ змінено {r.studies_changed_by === "referrer" ? "направником" : "клінікою"}</span>}</div>
                      <div className="du">{km}</div>
                    </div>
                    <div className="q-room" style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 3 }}>
                      {km && <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 5, lineHeight: 1.4, background: km === "КТ" ? "var(--orange-bg)" : "var(--blue-bg)", color: km === "КТ" ? "var(--orange)" : "#4da3ff" }}>{km}</span>}
                      <b>{room ? room.name : (centersById[r.clinic_id]?.name || "—")}</b>
                      {room?.apparatus_model ? <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{room.apparatus_model}</span> : null}
                    </div>
                    <div className="q-status-cell">
                      <span className={"badge " + meta.cls} title={"title" in meta ? meta.title : undefined}>{meta.label}</span>
                      <span title={"Дзвінок: " + call.label} aria-label={"Статус дзвінка: " + call.label} style={{ fontSize: 11.5, display: "inline-flex", alignItems: "center", gap: 4, color: CALL_COLOR[r.call_status || "not_called"], fontWeight: 600 }}>
                        <span aria-hidden="true">{call.icon}</span>{call.label}
                      </span>
                    </div>
                    <span className={"q-chev" + (expanded ? " open" : "")} aria-hidden="true">›</span>
                  </div>

                  <div className="qrow-detail-wrap">
                    <div className="qrow-detail-inner">
                      <div className="qrow-detail">
                        {(() => {
                          const sdiff = diffStudies(r.studies_original as Parameters<typeof diffStudies>[0], r.studies as Parameters<typeof diffStudies>[1]);
                          return (
                            <div className="qd-info" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "11px 22px", paddingTop: 4 }}>
                              <div className="qd-row"><span className="qd-k">Центр</span><span className="qd-v">{centerLabel(centersById[r.clinic_id])}</span></div>
                              <div className="qd-row"><span className="qd-k">Телефон</span><span className="qd-v">{r.patient_phone || "—"}</span></div>
                              <div className="qd-row"><span className="qd-k">Дзвінок</span><span className="qd-v" style={{ color: CALL_COLOR[r.call_status || "not_called"] }}>{call.label}</span></div>
                              <div className="qd-row" style={{ gridColumn: "1 / -1" }}>
                                <span className="qd-k">Дослідження{changed && <span style={{ color: "var(--orange)" }}> · змінено {r.studies_changed_by === "referrer" ? "направником" : "клінікою"}</span>}{r.contraindications && <span style={{ color: "var(--red)", fontWeight: 600 }}> · ⚠ Протипоказання</span>}</span>
                                <span className="qd-v" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                                  {sdiff.map((d, i) => (
                                    <span key={i} style={{ color: d.state === "added" ? "var(--green)" : d.state === "removed" ? "var(--red)" : "var(--text)", textDecoration: d.state === "removed" ? "line-through" : "none" }}>
                                      {d.state === "added" ? "＋ " : d.state === "removed" ? "－ " : ""}{studyText(d.s)}
                                    </span>
                                  ))}
                                </span>
                              </div>
                              {r.indication && <div className="qd-row" style={{ gridColumn: "1 / -1" }}><span className="qd-k">Питання</span><span className="qd-v">{r.indication}</span></div>}
                              {r.status === "no_show" && r.note && <div className="qd-row" style={{ gridColumn: "1 / -1" }}><span className="qd-k" style={{ color: "var(--red)" }}>Причина</span><span className="qd-v">{r.note}</span></div>}
                            </div>
                          );
                        })()}
                        {(() => { const h = fmtOrigin(r.reschedule_origin as unknown as RescheduleOrigin | null, roomById); return h ? <div className="ctx-hint" style={{ fontSize: 12 }}>{h}</div> : null; })()}
                        {owned && r.status !== "done" && r.status !== "cancelled" && r.status !== "no_show" && r.status !== "not_held" && (
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                            <button className="btn btn-primary btn-sm" disabled={r.status === "in_progress"} title={r.status === "in_progress" ? "Дослідження триває — недоступно" : "Перезаписати"} onClick={() => onReschedule(r)}>🗓 Перезаписати</button>
                            <button className="btn btn-secondary btn-sm" onClick={() => onEditStudies(r)}>🩻 Дослідження</button>
                            <button className="btn btn-secondary btn-sm" onClick={() => onEditPatient(r)}>✎ Дані пацієнта</button>
                            {canCancel(r) && <button className="btn btn-secondary btn-sm" style={{ color: "var(--red)" }} onClick={() => onCancel(r)}>✕ Скасувати</button>}
                          </div>
                        )}
                        {owned && r.status === "in_progress" && (
                          <div className="ctx-hint blue" style={{ fontSize: 12 }}>Дослідження вже почалося — зміни через центр.</div>
                        )}
                        {!owned && (
                          <div className="ctx-hint" style={{ fontSize: 12 }}>Запис створив центр — керується центром (зміни недоступні).</div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
      </div>
      <aside style={{ position: "sticky", top: 8 }}>
        <MiniCalendar selectedDate={calDate} onSelectDate={(d) => setDateFilter(dk(d))} highlightSelected={!!dateFilter} />
        {dateFilter && (
          <button className="btn btn-secondary btn-sm" style={{ width: "100%", marginTop: 8, justifyContent: "center" }} onClick={() => setDateFilter("")}>Всі дати</button>
        )}
      </aside>
    </div>
  );
}
