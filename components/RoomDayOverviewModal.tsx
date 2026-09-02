"use client";

import { useMemo, useState } from "react";
import SlotPicker from "@/components/SlotPicker";
import { useModalA11y } from "@/lib/useModalA11y";
import { useRoomBusy, busyAt, busyTooltip } from "@/lib/slotBusy";
import { buildSlots, slotToMin } from "@/lib/slots";
import { inBreak, overrideOn, roomBreaksFromFeed, roomScheduleFromFeed, dateKeyOf, type OverrideFeed } from "@/lib/schedule";
import { incidentEffectiveEnd, roomIncidentsOf, wallNow, wallToday0, wallMinOfDay, type IncidentLike, type IncidentFeed } from "@/lib/incidents";
import { useFollowTodayKey, dayOfKey, dayShiftNoticeOf, dayShiftNoticeVerdict, type DayShiftNotice } from "@/lib/useFollowToday";
/* Формат дати — ТОЙ САМИЙ, що в банерах форм запису (`fmtShort`, «1 вересня»).
   Карта дня оголошена дзеркалом форми, тож і про перенесення вона мусить
   говорити тими самими словами; своя копія форматера розійшлася б із ними
   мовчки, як уже розходились три інші дублі правил у цьому проєкті. */
import { fmtShort } from "@/components/BookingModal";
import { modalityShort, modalityKind } from "@/lib/studies";

type Room = {
  id: string;
  name: string;
  modality: string;
  apparatus_model?: string | null;
  schedule?: unknown;
};
type RoomIncident = IncidentLike & { reason_label?: string | null };

type Props = {
  rooms: Room[];
  clinicTz: string;
  incidents: IncidentFeed<RoomIncident>;   // U-11: фід (rows+failed), не голий масив
  overrides: OverrideFeed;                 // U-16: фід (мапа+failed), не гола мапа
  onClose: () => void;
};

/* ⚠️ Г1-G (с53, знахідка ревʼю Б): ОДИН формат ключа доби на продукт — тут
   стояла сьома власна копія тіла `dateKeyOf`, і саме вона задає `day`, тобто
   `curKey` для спільного правила. Розходження двох копій формату вбило б
   перенесення МОВЧКИ, а разом із ним і банер. Локальний `pad` пішов із нею:
   інших споживачів у нього не було. */
const dateKey = (d: Date) => dateKeyOf(d);
const dateFromKey = (v: string) => {
  const [y, m, d] = v.split("-").map(Number);
  return new Date(y || 1970, (m || 1) - 1, d || 1);
};
/**
 * Read-only карта дня для администратора. Она намеренно использует те же
 * room_busy_slots + SlotPicker, что и перенос: визуальный ответ на вопрос
 * «кабинет свободен?» не должен расходиться с формой записи.
 */
export default function RoomDayOverviewModal({ rooms, clinicTz, incidents, overrides, onClose }: Props) {
  const dialogRef = useModalA11y<HTMLDivElement>(onClose);
  const [roomId, setRoomId] = useState(() => rooms[0]?.id || "");
  const [day, setDay] = useState(() => dateKey(wallToday0(clinicTz)));
  const [selectedSlot, setSelectedSlot] = useState("");
  /* ⚠️ U-72. `day` зафіксовано ініціалізатором, а `isToday` нижче рахується
     живим `wallToday0`. Після поправки годинника через північ вони розходяться,
     `isToday` стає хибним — і з `stateOf` зникає гілка «час уже минув»: карта
     дня показує ЦІЛИЙ день вільним. Карта оголошена дзеркалом форми запису,
     тож розбіжність саме тут читається як «у формі зайнято, а на карті вільно».
     Записів цей екран не робить, дата видима й редагована — тому й ціна нижча,
     ніж у форм. Правило те саме: винятків «тут лише перегляд» не тримаємо. */
  /* ⚠️ Г1-B (знахідка ревʼю Г по с51, пакет с52). До цієї правки виклик стояв
     БЕЗ `onShift` — і це давало рівно ту ваду, проти якої `onShift` заведено.
     РУЧНА зміна дати тут скидає обраний слот (`onChange` нижче), АВТОМАТИЧНА
     не скидала: слот «09:00», обраний на 2 вересня, лишався підсвіченим і
     підписаним у рядку «Обрано …» вже на карті 1 вересня. Екран оголошений
     дзеркалом форми запису, а адміністратор саме з нього диктує вільний час
     оператору або пацієнту — тобто називає час, звірений з ЧУЖОЮ добою, і
     жоден гард цього не ловить: карта нічого не пише.
     Скидання і банер — та сама пара, що у трьох форм запису; банер знімає той,
     хто взяв дату в свої руки (`onChange`), а не таймер. */
  /* ⚠️ Г1-G (с53): стан у КЛЮЧАХ доби, а рукописна пара умов замінена спільним
     правилом із `lib/useFollowToday.ts` — своя копія була і тут. */
  const [dayShifted, setDayShifted] = useState<DayShiftNotice | null>(null);
  useFollowTodayKey({ clinicTz, value: day, setKey: setDay,
    onShift: (d, prev) => { setSelectedSlot(""); setDayShifted((s) => dayShiftNoticeOf(s, prev, d)); } });
  /* ⚠️ Г1-G: ОДИН вердикт на банер — другий екземпляр умови розійшовся б мовчки.
     ТРИЗНАЧНИЙ (ревʼю А по Г1-G): «туди-назад» — не тиша, `setSelectedSlot("")`
     відпрацював двічі. До Г1-G тут стояло «і це видно» — не аргумент: порожнє
     поле без причини і є та сама тиха вада навиворіт. */
  const dayShiftSay = dayShiftNoticeVerdict(dayShifted, day);

  const room = rooms.find((r) => r.id === roomId) || null;
  const date = useMemo(() => dateFromKey(day), [day]);
  /* U-16: `null` = особливі графіки дня не прочитались. Порожня мапа на місці
     збою означала б «особливих днів немає», і день, закритий ЛИШЕ через
     override, малювався б повною сіткою вільних слотів — на екрані, який
     МУСИТЬ збігатися з формою запису. Той самий клас, що U-11, інший канал. */
  const schedule = roomScheduleFromFeed(date, roomId, overrides, room?.schedule ?? null);
  const overridesFailed = schedule === null;
  /* ⚠️ `|| []` тут — ЄДИНЕ місце в пакеті, де невідомість стає порожнечею, і
     безпечне воно лише композиційно: при `overridesFailed` гілка-банер нижче
     перехоплює рендер, `slots` порожній, а `stateOf` має власну розтяжку
     («невідомо → blocked»). Тобто ні `inBreak`, ні `breaks.map`, ні
     `breaks.length` до цього масиву не доходять. Виносиш розрахунок сітки
     з-під тієї гілки — спершу поверни сюди `null` (ревʼю р1 F4 / р2 F7). */
  const breaks = roomBreaksFromFeed(date, roomId, room?.schedule ?? null, overrides) || [];
  const { spans, loading, error, reload } = useRoomBusy({ roomId, dateStr: day, enabled: !!roomId });
  /* Примітиви в депсах: сам `schedule` — новий обʼєкт на кожен рендер.
     Невідомий графік дає порожню сітку так само, як зачинений день: показувати
     її нема з чого, а гілка-банер нижче все одно перехоплює цей стан. */
  const dayClosed = !!schedule?.closed;
  const dayStart = schedule?.start ?? "";
  const dayEnd = schedule?.end ?? "";
  const slots = useMemo(
    () => (overridesFailed || dayClosed ? [] : buildSlots(slotToMin(dayStart), slotToMin(dayEnd))),
    [overridesFailed, dayClosed, dayStart, dayEnd],
  );
  // Настінний час клініки як хвилини доби. wallNow(tz) уже повертає wall-as-UTC,
  // тож БЕРЕМО wallMinOfDay (UTC-поля), а НЕ форматуємо ще раз у clinicTz —
  // інакше зсув таймзони застосовувався б ДВІЧІ (13:42 ставало 16:42, і всі
  // слоти до 16:40 хибно позначались «Цей час уже минув»).
  const nowMin = wallMinOfDay(wallNow(clinicTz));
  const isToday = day === dateKey(wallToday0(clinicTz));
  /* U-11: null = простої не прочитались. Ця карта — read-only відповідь на
     питання «кабінет вільний?», і вона мусить збігатися з формою запису;
     порожній масив на місці збою малював би ремонт вільним часом. */
  const roomIncidents = roomIncidentsOf(incidents, roomId);
  const incidentsFailed = roomIncidents === null;

  const incidentAt = (min: number) => {
    const instant = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(min / 60), min % 60);
    return (roomIncidents || []).find((i) => instant >= new Date(i.started_at).getTime() && instant < incidentEffectiveEnd(i));
  };
  const stateOf = (slot: string) => {
    const min = slotToMin(slot);
    // Страховка на випадок, якщо гілку-банер колись приберуть: невідомо ≠ вільно.
    if (incidentsFailed) return "blocked";
    if (overridesFailed) return "blocked";
    if (incidentAt(min)) return "blocked";
    const busy = busyAt(spans, min);
    if (busy) return min >= busy.eStudy ? "buffer" : "busy";
    if (inBreak(min, breaks)) return "break";
    // SlotPicker already has a neutral muted style for `tight`; in this read-only
    // screen it denotes elapsed time rather than an insufficient booking duration.
    if (isToday && min < nowMin) return "tight";
    return "free";
  };
  const titleOf = (slot: string, state: string) => {
    const min = slotToMin(slot);
    if (state === "blocked") {
      const incident = incidentAt(min);
      return `Кабінет недоступний${incident?.reason_label ? ` · ${incident.reason_label}` : ""}`;
    }
    if (state === "busy" || state === "buffer") {
      const busy = busyAt(spans, min);
      return busy ? (state === "buffer" ? `Буфер після дослідження\n${busyTooltip(busy)}` : busyTooltip(busy)) : "Зайнято";
    }
    if (state === "break") {
      const brk = inBreak(min, breaks);
      return brk ? `Перерва · ${brk.start}–${brk.end}` : "Перерва";
    }
    if (state === "tight") return "Цей час уже минув";
    return `Вільно · ${slot}`;
  };

  const occupiedMin = spans.reduce((sum, s) => sum + (s.e - s.s), 0);

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog fade-in" style={{ maxWidth: 620 }} ref={dialogRef} role="dialog" aria-modal="true" aria-label="Зайнятість кабінету">
        <div className="dlg-head">
          <div className="dlg-title"><span className="tic" style={{ background: "var(--blue-bg)", color: "var(--blue-text)" }}>▦</span>Зайнятість кабінету</div>
          <button className="icon-btn" onClick={onClose} aria-label="Закрити">✕</button>
        </div>
        <div className="dlg-body">
          <div className="ctx-hint blue" style={{ fontSize: "0.8125rem" }}>
            Карта дня оновлюється автоматично. Зайнятий час включає дослідження та буфер прибирання.
          </div>

          <div className="fld" style={{ marginTop: 14 }}>
            <span className="fld-lab">Кабінет</span>
            <div className="bd-rooms">
              {rooms.map((r) => (
                <button key={r.id} type="button" className={"bd-room" + (r.id === roomId ? " active" : "")}
                  onClick={() => { setRoomId(r.id); setSelectedSlot(""); }} title={r.apparatus_model ? `${r.name} · ${r.apparatus_model}` : r.name}>
                  <span className={"bd-room-kind " + modalityKind(r.modality)}>{modalityShort(r.modality)}</span>
                  <span className="bd-room-meta"><span className="bd-room-name">{r.name}</span><span className="bd-room-model">{r.apparatus_model || ""}</span></span>
                </button>
              ))}
            </div>
          </div>

          <div className="fld-row" style={{ alignItems: "end" }}>
            <label className="fld" style={{ maxWidth: 200 }}><span className="fld-lab">Дата</span>
              <input className="inp tabular" type="date" value={day} onChange={(e) => { setDay(e.target.value); setSelectedSlot(""); setDayShifted(null); }} />
            </label>
            <div className="fld" style={{ paddingBottom: 8 }}>
              <span className="fld-lab">Режим дня</span>
              {/* U-16: не стверджуємо ані «працює», ані «не працює», поки не
                  прочитали особливі графіки — обидва варіанти були б вигадкою. */}
              <b>{!schedule ? "Не завантажено" : schedule.closed ? "Кабінет не працює" : `${schedule.start}–${schedule.end}`}</b>
              {schedule?.custom && <span style={{ marginLeft: 6, color: "var(--blue-text)", fontSize: "0.75rem" }}>особливий графік</span>}
            </div>
          </div>

          {/* ⚠️ Г1-B: банер СТОЇТЬ НАД гілками нижче, а не всередині — інакше
              при закритому дні / збої читання (там рендер перехоплюється) він
              зник би саме тоді, коли розбіжність доби найдорожча.
              Називає ОБИДВІ доби з тієї самої причини, що й у форм (F7): ту, що
              «була», адміністратор уже сказав уголос, і відкликати треба саме її.

              ⚠️ `from !== to` — НЕ косметика (знахідка ревʼю А по цьому пакету).
              `from` навмисно не затирається другим викликом, і на поправці, що
              зʼїхала й повернулась (01→02→01 — штатний випадок, під нього ж
              написана «фантомна» гілка в `decideShift`), накопичене `from`
              збігається з новим `to`. Банер читався б «день змінено з 1 вересня
              на 1 вересня» — тобто екран стверджував би зміну, якої в підсумку
              не сталось.
              ⚠️ Г1-G ЗАКРИТО (с53): умова більше не рукописна і не місцева —
              вердикт дає спільне `dayShiftNoticeVerdict`, те саме в усіх шести
              екранах і на двох дошках. Раніше цієї умови не було в чотирьох із
              шести, і саме розходження рукописних копій було самим боргом.
              ⚠️ І ВІДРАЗУ ПОПРАВКА ДО ЦЬОГО Ж КОМЕНТАРЯ (ревʼю А по Г1-G).
              Тут стояло «слот при цьому справді скинуто двічі, і це видно» —
              це не аргумент, а та сама тиха вада навиворіт: порожнє поле часу
              без причини оператор читає як збій форми. Тому «туди-назад» тепер
              не мовчить, а каже СВОЇМ текстом — банер є, але про скинутий час,
              а не про зміну дня, якої не сталось. */}
          {dayShifted && dayShiftSay !== "none" && (
            <div className="ctx-hint" role="status" style={{ marginTop: 6 }}>
              {dayShiftSay === "moved"
                ? <>🕐 Годинник центру уточнено — день змінено з <b>{fmtShort(dayOfKey(dayShifted.fromKey))}</b> на <b>{fmtShort(dayOfKey(dayShifted.toKey))}</b>. Це вже інша карта: назвіть вільний час заново.</>
                : <>🕐 Годинник центру уточнювався двічі і повернувся на <b>{fmtShort(dayOfKey(dayShifted.toKey))}</b> — день той самий, але обраний час скинуто. Оберіть його заново.</>}
            </div>
          )}

          {/* U-16: гілка невідомості — ПЕРША. Раніше першим стояв `schedule.closed`,
              а він порахований із мапи, якої могло не бути: при збої читання
              екран спокійно казав «не працює» або малював повну сітку вільних
              слотів. Порядок тут — частина правила, а не оформлення. */}
          {overridesFailed ? (
            <div className="ctx-hint red">⚠ Не вдалося завантажити особливі графіки дня — режим роботи кабінету невідомий. Вільний час не показано. Оновіть сторінку.</div>
          ) : schedule.closed ? (
            <div className="ctx-hint red">🚫 {room?.name || "Кабінет"} не працює цього дня{overrideOn(overrides, day)?.label ? ` · ${overrideOn(overrides, day)?.label}` : ""}.</div>
          ) : (error || incidentsFailed) ? (
            /* U-11: збій простоїв ховає сітку так само, як збій зайнятості —
               інакше карта показала б «вільно» там, де кабінет на ремонті. */
            <div className="ctx-hint red">⚠ Не вдалося завантажити {error && incidentsFailed ? "зайнятість і простої" : error ? "зайнятість" : "простої"} кабінету. Вільний час не показано.
              {error && <button type="button" className="btn btn-secondary btn-sm" style={{ marginLeft: 6 }} onClick={reload}>Спробувати ще раз</button>}
              {!error && incidentsFailed && <span style={{ marginLeft: 6 }}>Оновіть сторінку.</span>}
            </div>
          ) : loading ? (
            <div className="ctx-hint" style={{ padding: "22px 0", textAlign: "center", color: "var(--text-muted)" }}>⏳ Завантаження зайнятості…</div>
          ) : (
            <>
              <div className="bk-busy-list" style={{ marginTop: 4 }}>
                <span className="bk-busy-lab">За день:</span>
                <span className="bk-busy-chip">{spans.length} записів</span>
                <span className="bk-busy-chip">зайнято {occupiedMin} хв</span>
                {breaks.map((b) => <span className="bk-busy-chip" key={`${b.start}-${b.end}`}>перерва {b.start}–{b.end}</span>)}
              </div>
              <div className="fld" style={{ marginTop: 12 }}>
                <span className="fld-lab">Сітка дня · крок 5 хв</span>
                <SlotPicker slots={slots} stateOf={stateOf} value={selectedSlot} onChange={setSelectedSlot} titleOf={titleOf} freeStates={["free"]} />
              </div>
              <div className="bk-slot-legend">
                <span><span className="lg-dot free" />вільно</span>
                <span><span className="lg-dot busy" />дослідження</span>
                <span><span className="lg-dot busybuf" />буфер</span>
                {breaks.length > 0 && <span><span className="lg-dot brk" />перерва</span>}
                {(roomIncidents || []).length > 0 && <span><span className="lg-dot busy" />простій / ТО</span>}
                {isToday && <span><span className="lg-dot tight" />час минув</span>}
              </div>
              {selectedSlot && <div className="ctx-hint blue" style={{ marginTop: 10 }}>Обрано {selectedSlot} · {titleOf(selectedSlot, stateOf(selectedSlot))}</div>}
            </>
          )}
        </div>
        <div className="dlg-foot"><span style={{ fontSize: "0.75rem", color: "var(--text-faint)", marginRight: "auto" }}>Дані оновлюються при зміні черги або інциденту.</span><button className="btn btn-primary" onClick={onClose}>Готово</button></div>
      </div>
    </div>
  );
}
