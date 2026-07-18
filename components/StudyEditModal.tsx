"use client";

/* ===== RadFlow — Редактор досліджень =====
   Портовано з rf-shell.jsx (StudyEditModal). Тип фіксується кабінетом (МРТ/КТ).
   Сумарна тривалість не може перевищити вільний час до наступного запису —
   зайнятість кабінету беремо через знеособлений RPC room_busy_slots (без PII;
   для направника обходить RLS-сліпоту), p_exclude прибирає сам редагований запис. */

import { useState, useEffect, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { BUFFER_DEFAULT, BUFFER_OPTIONS, normBuffer, normDur, CONTRAST_DUR, BOOKABLE_MODALITIES, modalityLabel, modalityShort, modalityKind } from "@/lib/studies";
import { buildCatalog, type ServiceLike } from "@/lib/catalog";
import { roomScheduleFor, effectiveRoomBreaks, OFF_SCHED_GRACE_MIN, type DayOverride } from "@/lib/schedule";
import { wallNow, wallMinOfDay, wallDayKey, wallToday0 } from "@/lib/incidents";
import { useModalA11y } from "@/lib/useModalA11y";

const MIN_STUDY = 15;

type RoomOpt = { id: string; modality: string; name: string; apparatus_model?: string | null };
type StudyRow = { type: string; region: string; dur: number; contrast: boolean };
/** Те, що летить у studies (jsonb) — як у BookingModal: з контрастом і ціною. */
type StudyOut = { type: string; region: string; contrast: boolean; dur: number; price: number | null };
type StudyLike = { type?: string; region?: string; dur?: number; contrast?: boolean };
type StudyPatient = { id: string; room_id: string | null; scheduled_time: string | null; buffer_time_min?: number | null; duration_min?: number | null; patient_name: string | null; studies?: unknown };

interface StudyEditModalProps {
  patient: StudyPatient;
  scheduledDate?: string | null;
  rooms?: RoomOpt[];
  clinicId?: string | null;
  clinicTz?: string | null; // TZ центру запису (мультиклінічний портал направника)
  /** Каталог послуг центру запису (services, 0107). Порожній → статичний фолбэк. */
  services?: ServiceLike[];
  onClose: () => void;
  onConfirm: (arr: StudyOut[], meta: { dur: number; buffer: number; offSchedule?: boolean }) => void;
  /* 0077: запис САМ стоїть поза графіком (створений/перенесений за підтвердженням).
     Тоді кінець графіка і перерва його вже не обмежують — інакше легально створений
     запис на 17:55 неможливо було б відредагувати взагалі. */
  offSchedule?: boolean;
}

function pad(n: number) { return String(n).padStart(2, "0"); }
function toMin(t: string | null | undefined) { const p = String(t || "").split(":"); return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0); }
function fmt(m: number) { return pad(Math.floor(m / 60)) + ":" + pad(m % 60); }

export default function StudyEditModal({ patient, scheduledDate, rooms, clinicId, clinicTz, services, onClose, onConfirm, offSchedule = false }: StudyEditModalProps) {
  const dialogRef = useModalA11y<HTMLDivElement>(onClose);
  // Каталог послуг центру (фаза 2a): drop-in шорткати lib/studies. Порожній → статика.
  const catalog = useMemo(() => buildCatalog(services), [services]);
  const regionsFor = catalog.regionsFor;
  const studyDur = catalog.studyDur;
  const studyPrice = catalog.studyPrice;
  const room = (rooms || []).find((r) => r.id === patient.room_id);
  const roomKind = room ? modalityLabel(room.modality) : "МРТ"; // укр. лейбл модальності кабінету
  // Тип дослідження задає кабінет, якщо його модальність відома (МРТ/КТ/УЗД/Рентген/Мамографія).
  const lockType = roomKind !== "Інше";
  const defaultType = lockType ? roomKind : "МРТ";

  const [nextStart, setNextStart] = useState<number | null>(null);
  const [override, setOverride] = useState<DayOverride | null>(null);
  const [roomSchedule, setRoomSchedule] = useState<unknown>(null); // rooms.schedule кабінету (для перерв)
  // H-6: зайнятість кабінету — це стан «завантажено / помилка», а не просто null.
  // Поки зайнятість НЕ підтверджена (грузиться або впала), nextStart=null не можна
  // трактувати як «наступних записів немає» — інакше capByNext=Infinity ЗАВИЩУЄ
  // доступну тривалість (fail-open) і оператор задасть тривалість, яку відкине сервер.
  const [busyReady, setBusyReady] = useState(false);   // маємо надійну відповідь про nextStart
  const [busyErr, setBusyErr] = useState(false);        // читання зайнятості впало
  useEffect(() => {
    let cancel = false;
    setBusyReady(false); setBusyErr(false);
    (async () => {
      if (!patient.room_id || !scheduledDate) { if (!cancel) setBusyReady(true); return; } // нема що перевіряти
      try {
        const supabase = createClient();
        if (clinicId) {
          const ov = await supabase.from("schedule_overrides").select("all_closed, label, rooms").eq("clinic_id", clinicId).eq("override_date", scheduledDate).maybeSingle();
          if (!cancel) setOverride((ov.data as unknown as DayOverride) || null);
        }
        const roomRes = await supabase.from("rooms").select("schedule").eq("id", patient.room_id).maybeSingle();
        if (!cancel) setRoomSchedule((roomRes.data as { schedule?: unknown } | null)?.schedule ?? null);
        // Знеособлена зайнятість кабінету; p_exclude прибирає сам редагований запис.
        const { data, error } = await supabase.rpc("room_busy_slots", { p_room: patient.room_id, p_date: scheduledDate, p_exclude: patient.id });
        if (cancel) return;
        if (error) throw error;   // не ковтаємо: «пусто» ≠ «помилка» (6.4)
        /* Найближчий СЛІДУЮЧИЙ запис у кабінеті — щоб не подовжити дослідження
           поверх нього. 0074: беремо start_min (обрізаний по добі); «хвости» з
           попередньої доби мають start_min = 0 і сюди не потраплять (вони раніше
           за наш старт) — саме те, що треба. */
        const startMin = toMin(patient.scheduled_time);
        const ns = (data || [])
          .map((p) => (p.start_min != null ? p.start_min : toMin(p.scheduled_time)))
          .filter((m) => m > startMin)
          .sort((a, b) => a - b)[0];
        setNextStart(ns != null ? ns : null);
        setBusyReady(true);
      } catch {
        // Транзієнтний збій (оновлення токена / мережа) — не рушимо модаль, але
        // ПОЗНАЧАЄМО помилку: capByNext стане консервативним (fail-closed).
        if (!cancel) { setNextStart(null); setBusyErr(true); }
      }
    })();
    return () => { cancel = true; };
  }, [patient.id, patient.room_id, patient.scheduled_time, scheduledDate, clinicId]);

  const [buffer, setBuffer] = useState<number>(normBuffer(patient.buffer_time_min ?? BUFFER_DEFAULT));

  const startMin = toMin(patient.scheduled_time);
  // Реальний старт: якщо запис сьогодні і плановий час уже минув (пацієнт
  // запізнюється або вже в кабінеті), фактична зайнятість кабінету рахується
  // від ЗАРАЗ, а не від планового слота. Використовується для м'якого
  // попередження про наїзд на наступний запис (плановий check_no_overlap
  // цього не ловить, бо порівнює планові вікна).
  // «Зараз» у настінному часі клініки (wall-as-UTC мс): і хвилини доби, і дата.
  const _nowW = wallNow(clinicTz || undefined);
  const nowMin = wallMinOfDay(_nowW);
  const todayStr = wallDayKey(clinicTz || undefined);   // «сьогодні» клініки (спільний хелпер)
  const isTodayLate = scheduledDate === todayStr && nowMin > startMin;
  const refStartMin = isTodayLate ? nowMin : startMin;
  // Кінець вікна — за графіком кабінету (з урахуванням особливого графіка),
  // але не далі наступного запису. Буфер займає кабінет ПІСЛЯ досліджень, тож
  // дослідження + буфер не повинні перетнути наступний запис (для графіка —
  // саме дослідження має вміститись, буфер може вийти за межі закриття).
  const dateObj = scheduledDate ? new Date(scheduledDate + "T00:00:00") : wallToday0(clinicTz || undefined);
  const roomSched = roomScheduleFor(dateObj, patient.room_id || "", override, roomSchedule);
  const schedEnd = toMin(roomSched.end);
  /* Стеля за наступним записом. КЛЮЧОВЕ: поки зайнятість не підтверджена
     (busyReady=false: грузиться або впала), НЕ ставимо Infinity — це завищувало б
     доступний час (fail-open). Замість цього консервативна стеля = ПОТОЧНА
     тривалість запису: редагувати/скоротити можна, ЗБІЛЬШИТИ — ні (overflow), поки
     не знаємо про наступний запис. Коли завантажилось — стеля стає справжньою. */
  const capByNext = busyReady
    ? (nextStart != null ? nextStart - startMin - buffer : Infinity)
    : (patient.duration_min && patient.duration_min > 0 ? patient.duration_min : Infinity);
  /* 0077 — ЗАПИС, ЩО ВЖЕ СТОЇТЬ ПОЗА ГРАФІКОМ, теж треба вміти редагувати.
     Без цього запис на 17:55 у кабінеті, що закривається о 18:00, давав
     availableDur = 5 хв → «⚠ Не вміщується» і кнопка «Зберегти» назавжди сіра:
     легально створений запис ставав невиправним. Стеля та сама, що в сітці
     (+OFF_SCHED_GRACE_MIN), а перерва позначений запис уже не обмежує — він і так
     у ній стоїть (тригер 0067 пускає рядки з прапорцем).
     ⚠️ Це НЕ дозвіл тягнути далі: нове перетинання межі вимагає окремої згоди
     (offOk нижче), а сервер усе одно перевірить scheduleBlock. */
  const capBySched = (offSchedule ? schedEnd + OFF_SCHED_GRACE_MIN : schedEnd) - startMin;
  // Перерва кабінету після старту теж обмежує тривалість — дослідження не може її перетнути.
  const nextBreakStart = effectiveRoomBreaks(dateObj, patient.room_id || "", roomSchedule, override).map((b) => toMin(b.start)).filter((m) => m > startMin).sort((a, b) => a - b)[0];
  const capByBreak = offSchedule ? Infinity : (nextBreakStart != null ? nextBreakStart - startMin : Infinity);
  const availableDur = Math.max(0, Math.min(capByNext, capBySched, capByBreak));
  // Межа, за якою потрібне НОВЕ підтвердження (кінець графіка / початок перерви).
  const inSchedCap = Math.max(0, Math.min(capByNext, schedEnd - startMin, nextBreakStart != null ? nextBreakStart - startMin : Infinity));
  const windowLabel = (capByBreak <= capByNext && capByBreak <= capBySched && nextBreakStart != null)
    ? ("до перерви о " + fmt(nextBreakStart))
    : (nextStart != null && (nextStart - buffer) <= schedEnd)
      ? ("до наступного запису о " + fmt(nextStart) + (buffer > 0 ? ` − ${buffer} буфер` : ""))
      : ("до кінця графіка (" + fmt(schedEnd) + ")");

  // Тривалість за довідником + CONTRAST_DUR, якщо дослідження з контрастом.
  function recalc(type: string, region: string, contrast: boolean, prevDur?: number): number {
    const ro = regionsFor(type).find((r) => r.label === region);
    return ro ? studyDur(type, region, contrast) : (prevDur || (regionsFor(type)[0]?.dur ?? 20));
  }
  function seed(): StudyRow[] {
    const base: StudyLike[] = Array.isArray(patient.studies) && patient.studies.length
      ? (patient.studies as StudyLike[])
      : [{ type: defaultType, region: "", dur: regionsFor(defaultType)[0]?.dur ?? 20 }];
    return base.map((s) => {
      const t = lockType ? roomKind : (s.type || "МРТ");
      const keepRegion = !lockType || !s.type || s.type === roomKind;
      const region = keepRegion ? (s.region || "") : "";
      const contrast = keepRegion ? !!s.contrast : false; // ЗБЕРІГАЄМО наявний контраст
      return { type: t, region, contrast, dur: region ? (s.dur || recalc(t, region, contrast)) : recalc(t, "", contrast) };
    });
  }
  const [rows, setRows] = useState<StudyRow[]>(seed);

  function patch(i: number, p: Partial<StudyRow>) { setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...p } : r))); }
  function setType(i: number, type: string) { if (lockType) return; patch(i, { type, region: "", contrast: false, dur: recalc(type, "", false) }); }
  function setRegion(i: number, region: string) { const r = rows[i]; patch(i, { region, dur: recalc(r.type, region, r.contrast, r.dur) }); }
  // Контраст: ±CONTRAST_DUR до поточної тривалості (зберігає ручні правки тривалості).
  function setContrast(i: number, contrast: boolean) {
    const r = rows[i];
    if (r.contrast === contrast) return;
    const delta = contrast ? CONTRAST_DUR : -CONTRAST_DUR;
    patch(i, { contrast, dur: Math.max(5, (Number(r.dur) || 0) + delta) });
  }
  // H-1: кратно 5, 5..480 — те саме обмеження, що CHECK у БД (0066).
  function setDur(i: number, v: string) { patch(i, { dur: normDur(parseInt(v, 10)) }); }
  function addRow() { setRows((rs) => [...rs, { type: defaultType, region: "", contrast: false, dur: recalc(defaultType, "", false) }]); }
  function removeRow(i: number) { setRows((rs) => (rs.length > 1 ? rs.filter((_, idx) => idx !== i) : rs)); }

  const totalDur = rows.reduce((s, r) => s + (Number(r.dur) || 0), 0);
  const overflow = totalDur > availableDur;
  const remaining = availableDur - totalDur;
  // М'яке попередження (НЕ блокує збереження): за фактом старту дослідження+буфер
  // закінчаться пізніше наступного запису кабінету.
  const projectedEndMin = refStartMin + totalDur + buffer;
  const realClash = isTodayLate && nextStart != null && projectedEndMin > nextStart;
  const canAdd = remaining >= MIN_STUDY;
  /* 0077: тривалість перетнула межу графіка/перерви — потрібна ОКРЕМА згода.
     Без цього збережений колись прапорець працював би як «вічний дозвіл»: запис,
     підтверджений на 5 хв понаднормово, мовчки розтягнули б ще на дві години. */
  const [offOk, setOffOk] = useState(false);
  const crossesNow = totalDur > inSchedCap;
  const needsOffConfirm = crossesNow && !overflow;
  const valid = rows.length > 0 && rows.every((r) => r.region) && !overflow && (!needsOffConfirm || offOk);

  function save() {
    // Пишемо повний склад (як BookingModal): контраст + ціна. Раніше вони губилися
    // при редагуванні — has_contrast на сервері рахується саме зі studies.
    const arr: StudyOut[] = rows.filter((r) => r.region).map((r) => ({
      type: r.type,
      region: r.region,
      contrast: r.contrast,
      dur: Number(r.dur) || 0,
      price: studyPrice(r.type, r.region, r.contrast),
    }));
    /* offSchedule: або запис і був поза графіком (успадкований прапорець), або
       оператор щойно підтвердив нове перетинання межі. Сервер однаково перерахує
       факт сам (scheduleBlock) — сюди їде саме ЗГОДА, а не «стан слота». */
    onConfirm(arr, { dur: totalDur, buffer, offSchedule: offSchedule || (needsOffConfirm && offOk) });
  }

  return (
    <div className="overlay">
      <div className="dialog fade-in" style={{ maxWidth: 600 }} ref={dialogRef} role="dialog" aria-modal="true" aria-label="Редагування дослідження">
        <div className="dlg-head">
          <div className="dlg-title"><span className="tic" style={{ background: "var(--blue-bg)", color: "var(--blue)" }}>🩻</span>Дослідження пацієнта</div>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="dlg-body">
          <div className="ctx-hint blue" style={{ fontSize: 13 }}>Пацієнт: <b>{patient.patient_name}</b> · слот {scheduledDate ? <><b>{scheduledDate.split("-").reverse().join(".")}</b> о </> : "о "}<b>{patient.scheduled_time}</b>{room ? <> · {room.name}{lockType ? <> · <b>{roomKind}</b></> : null}</> : null}. {lockType ? <>Усі дослідження слота — лише <b>{roomKind}</b>.</> : null}</div>
          <div className={"ctx-hint " + (overflow ? "red" : "blue")} style={{ fontSize: 12.5 }}>
            {overflow
              ? <>⚠ Не вміщується: разом <b>{totalDur} хв</b>, доступно <b>{availableDur} хв</b> ({windowLabel}). Скоротіть на {totalDur - availableDur} хв.</>
              : <>Доступно у слоті: <b>{availableDur} хв</b> ({windowLabel}). Вільно ще <b>{remaining} хв</b>.</>}
          </div>
          {/* Поки зайнятість кабінету не підтверджена — не даємо збільшувати тривалість
              (fail-closed). При помилці читання це не транзієнт «пусто», а невідомий стан. */}
          {!busyReady && (
            <div className={"ctx-hint " + (busyErr ? "orange" : "blue")} style={{ fontSize: 12 }}>
              {busyErr
                ? <>⚠ Не вдалося перевірити зайнятість кабінету — збільшувати тривалість поки не можна. Закрийте й відкрийте вікно, щоб спробувати ще раз.</>
                : <>Перевіряю зайнятість кабінету…</>}
            </div>
          )}
          {!overflow && realClash && (
            <div className="ctx-hint red" style={{ fontSize: 12.5 }}>
              ⚠ Пацієнт запізнюється/у кабінеті: за фактом (з ~<b>{fmt(refStartMin)}</b>) дослідження + буфер закінчаться о ~<b>{fmt(projectedEndMin)}</b> і перекриють наступний запис о <b>{fmt(nextStart ?? 0)}</b>. Зберегти можна, але перенесіть наступний запис.
            </div>
          )}
          {/* 0077 — тривалість вивела дослідження за графік / у перерву: окрема згода.
              Успадкований прапорець запису тут НЕ рахується за підтвердження — інакше
              одна давня згода дозволяла б тягнути дослідження скільки завгодно. */}
          {needsOffConfirm && (
            <div className="info-banner offsched" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
              <span className="ib-txt">
                <b>⏰ Поза графіком.</b> Разом <b>{totalDur} хв</b> — дослідження вийде за межу
                (<b>{fmt(startMin + inSchedCap)}</b>: {windowLabel}). Кабінет працюватиме понаднормово.
              </span>
              <label className="fld-lab" style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input type="checkbox" checked={offOk} onChange={(e) => setOffOk(e.target.checked)} />
                Підтверджую роботу поза графіком
              </label>
            </div>
          )}
          <div className="st-rows">
            {rows.map((r, i) => {
              const regions = regionsFor(r.type);
              const hasRegion = !r.region || regions.some((x) => x.label === r.region);
              return (
                <div className="st-row" key={i}>
                  <div className="st-row-head">
                    <span className="st-row-n">Дослідження {i + 1}</span>
                    {rows.length > 1 && <button className="st-row-del" title="Прибрати" onClick={() => removeRow(i)}>✕</button>}
                  </div>
                  <div className="st-row-body">
                    <div className="st-field st-field-type">
                      <span className="st-flab">Тип</span>
                      {lockType ? (
                        <div className="bk-seg st-seg st-seg-locked" title="Тип апарата задає кабінет">
                          <button className={"bk-seg-btn active " + modalityKind(roomKind)} disabled>{modalityShort(roomKind)} 🔒</button>
                        </div>
                      ) : (
                        <div className="bk-seg st-seg" style={{ flexWrap: "wrap" }}>
                          {BOOKABLE_MODALITIES.map((code) => (
                            <button key={code} className={"bk-seg-btn" + (r.type === modalityLabel(code) ? " active " + modalityKind(code) : "")} onClick={() => setType(i, modalityLabel(code))} title={modalityLabel(code)}>{modalityShort(code)}</button>
                          ))}
                        </div>
                      )}
                    </div>
                    <label className="st-field st-field-region">
                      <span className="st-flab">Область дослідження</span>
                      <select className="inp" value={hasRegion ? r.region : ""} onChange={(e) => setRegion(i, e.target.value)}>
                        <option value="">— Оберіть область —</option>
                        {!hasRegion && r.region && <option value={r.region}>{r.region} (поточне)</option>}
                        {regions.map((x) => <option key={x.label} value={x.label}>{x.label} · {x.dur} хв</option>)}
                      </select>
                    </label>
                    <div className="st-field st-field-contrast">
                      <span className="st-flab">Контраст</span>
                      <label className={"rf-check" + (r.contrast ? " on" : "")} title={`Контраст: +${CONTRAST_DUR} хв до тривалості та доплата`}>
                        <input type="checkbox" checked={r.contrast} onChange={(e) => setContrast(i, e.target.checked)} />
                        <span className="rf-box" /><span>+{CONTRAST_DUR} хв</span>
                      </label>
                    </div>
                    <label className="st-field st-field-dur">
                      <span className="st-flab">Тривалість</span>
                      <div className="st-dur"><input className="inp" type="number" min="5" step="5" value={r.dur} onChange={(e) => setDur(i, e.target.value)} /><span className="st-dur-u">хв</span></div>
                    </label>
                  </div>
                </div>
              );
            })}
          </div>
          <button className="btn btn-secondary btn-sm" style={{ marginTop: 10 }} disabled={!canAdd} onClick={addRow}
            title={canAdd ? "" : "Немає вільного часу у слоті"}>＋ Додати дослідження</button>
        </div>
        <div className="dlg-foot">
          <label className="st-total" style={{ display: "flex", alignItems: "center", gap: 6 }} title="Буфер після дослідження (переукладка/дезінфекція)">
            Буфер:
            <select className="inp" style={{ width: 74, padding: "2px 6px" }} value={buffer} onChange={(e) => setBuffer(normBuffer(Number(e.target.value)))}>
              {BUFFER_OPTIONS.map((b) => <option key={b} value={b}>{b} хв</option>)}
            </select>
          </label>
          <span className="st-total">Разом: <b>{totalDur} хв</b>{buffer > 0 ? <> + {buffer} буфер</> : null} · {rows.length} {rows.length === 1 ? "дослідження" : "досл."}</span>
          <button className="btn btn-ghost" onClick={onClose}>Скасувати</button>
          <button className="btn btn-primary" disabled={!valid} onClick={save}>✓ Зберегти дослідження</button>
        </div>
      </div>
    </div>
  );
}
