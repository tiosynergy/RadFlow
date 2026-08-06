"use client";

/* ===== RadFlow — экран универсального поиска «Пошук» (с22) =====

   Клиент страницы /search: строка «Пацієнт або дослідження», панель фильтров,
   chips активных фильтров, серверная keyset-пагинация («Показати ще»), явные
   состояния: подсказка / скелет / пусто / ошибка (ошибка ≠ пустой результат).

   Приватность (ТЗ §6): поисковая строка и фильтры НЕ пишутся в URL, localStorage,
   sessionStorage, аналитику и console — всё состояние живёт только в памяти
   вкладки; после F5 запрос сбрасывается сознательно.

   Область данных определяет СЕРВЕР (POST /api/search) из сессии; пропсы страницы
   (клиники/кабинеты) — только справочники для подписей и выпадаек. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { modalityLabel } from "@/lib/studies";
import { wallDayKey } from "@/lib/incidents";
// Стилі прототипу — як у всіх дошок (QueueBoard/WaitlistBoard/CeoDashboard).
// Без цих імпортів сторінка рендериться голим HTML (спіймано живою перевіркою с22).
import "@/styles/prototype/radflow.css";
import "@/styles/prototype/radflow-screens.css";
import type { SearchRequest, SearchResponse, SearchResultItem } from "@/lib/searchContract";

export type SearchClinicOpt = { id: string; name: string };
export type SearchRoomOpt = { id: string; name: string; clinic_id: string; modality: string | null; active: boolean | null };

type Props = {
  roleKey: string;
  userName: string;
  clinics: SearchClinicOpt[];
  rooms: SearchRoomOpt[];
  sources: Array<"queue" | "waitlist">;
  backHref: string;
  showPhone: boolean;
  showReferrerCol: boolean;
  /** Зона клиники для дата-пресетов «Сьогодні/±7/±30» (инвариант M-4: день считается
   *  по клинике, не по браузеру). Мультиклиничным ролям приходит зона первой клиники. */
  clinicTz?: string | null;
};

const ST_QUEUE: Record<string, string> = {
  scheduled: "В черзі", waiting: "Очікує", in_progress: "В кабінеті", done: "Виконано",
  no_show: "Неявка", not_held: "Не відбулося", cancelled: "Скасовано", needs_reschedule: "Потребує переносу",
};
const ST_WL: Record<string, string> = { waiting: "Очікує", scheduled: "Записано", cancelled: "Знято", expired: "Прострочено" };
const PRIO: Record<string, string> = { cito: "CITO", urgent: "Терміново", planned: "Планово" };
const MODS = [
  { code: "MRI", lab: "МРТ" }, { code: "CT", lab: "КТ" }, { code: "US", lab: "УЗД" },
  { code: "XRAY", lab: "Рентген" }, { code: "MAMMO", lab: "Мамографія" }, { code: "OTHER", lab: "Інше" },
] as const;

type Period = "all" | "today" | "7" | "30" | "custom";

function shiftKey(key: string, days: number): string {
  const d = new Date(key + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function fmtDate(key: string | null): string {
  if (!key) return "—";
  const [y, m, d] = key.split("-");
  return `${d}.${m}.${y}`;
}

type UiState =
  | { kind: "idle" }
  | { kind: "hint"; msg: string }
  | { kind: "loading" }
  | { kind: "error"; msg: string }
  | { kind: "ready"; items: SearchResultItem[]; nextCursor: string | null; hasMore: boolean; loadingMore: boolean };

export default function SearchScreen({ roleKey, userName, clinics, rooms, sources, backHref, showPhone, showReferrerCol, clinicTz = null }: Props) {
  const [term, setTerm] = useState("");
  const [source, setSource] = useState<"queue" | "waitlist">(sources[0] || "queue");
  const [clinicId, setClinicId] = useState<string>("all");
  const [roomId, setRoomId] = useState<string>("all");
  const [period, setPeriod] = useState<Period>("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [status, setStatus] = useState<string>("all");
  const [mods, setMods] = useState<string[]>([]);
  const [contrast, setContrast] = useState<"any" | "yes" | "no">("any");
  const [prio, setPrio] = useState<string>("all");
  const [sortDesc, setSortDesc] = useState(true);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [st, setSt] = useState<UiState>({ kind: "idle" });

  const clinicsById = useMemo(() => Object.fromEntries(clinics.map((c) => [c.id, c.name])), [clinics]);
  const roomsById = useMemo(() => Object.fromEntries(rooms.map((r) => [r.id, r])), [rooms]);
  const roomOpts = useMemo(
    () => rooms.filter((r) => r.active !== false && (clinicId === "all" || r.clinic_id === clinicId)),
    [rooms, clinicId]
  );

  // Кабинет из другой клиники после смены фильтра клиники — сбрасываем.
  useEffect(() => {
    if (roomId !== "all" && !roomOpts.some((r) => r.id === roomId)) setRoomId("all");
  }, [roomOpts, roomId]);
  // Смена источника: статусные значения у очереди и листа разные.
  useEffect(() => { setStatus("all"); }, [source]);

  const buildRequest = useCallback((): SearchRequest => {
    const req: SearchRequest = { sources: [source], sort: sortDesc ? "date_desc" : "date_asc", limit: 25 };
    const t = term.trim();
    if (t) req.term = t;
    if (clinicId !== "all") req.clinicIds = [clinicId];
    if (roomId !== "all") req.roomIds = [roomId];
    // «Сьогодні» — по зоне КЛИНИКИ (ревью с22 р2 MEDIUM-B, инвариант M-4):
    // день браузера у оператора в другой зоне — это другой день клиники.
    const today = wallDayKey(clinicTz || undefined);
    if (period === "today") { req.dateFrom = today; req.dateTo = today; }
    else if (period === "7") { req.dateFrom = shiftKey(today, -7); req.dateTo = shiftKey(today, 7); }
    else if (period === "30") { req.dateFrom = shiftKey(today, -30); req.dateTo = shiftKey(today, 30); }
    else if (period === "custom") {
      if (dateFrom) req.dateFrom = dateFrom;
      if (dateTo) req.dateTo = dateTo;
    }
    if (status !== "all") {
      if (source === "queue") req.queueStatuses = [status as NonNullable<SearchRequest["queueStatuses"]>[number]];
      else req.waitlistStatuses = [status as NonNullable<SearchRequest["waitlistStatuses"]>[number]];
    }
    if (mods.length) req.modalities = mods as NonNullable<SearchRequest["modalities"]>;
    if (contrast !== "any") req.contrast = contrast === "yes";
    if (prio !== "all") req.priorities = [prio as NonNullable<SearchRequest["priorities"]>[number]];
    return req;
  }, [term, source, clinicId, roomId, period, dateFrom, dateTo, status, mods, contrast, prio, sortDesc, clinicTz]);

  /* Гонки запросов: считаем поколения; ответ устаревшего поколения игнорируем,
     сам запрос отменяем AbortController-ом. Подпись условий (reqSigRef) защищает
     «Показати ще» от курсора, полученного при ДРУГИХ фильтрах (ревью MEDIUM-2). */
  const seq = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const reqSigRef = useRef("");

  const runSearch = useCallback(
    async (append: boolean, cursor: string | null) => {
      const base = buildRequest();
      const sig = JSON.stringify(base);
      // Догрузка валидна только для тех же условий, при которых получен курсор.
      if (append && sig !== reqSigRef.current) return;
      const mySeq = ++seq.current;
      abortRef.current?.abort();
      const ctl = new AbortController();
      abortRef.current = ctl;
      if (!append) setSt((s) => (s.kind === "ready" ? { ...s, loadingMore: false } : s));
      try {
        const body: SearchRequest = { ...base, ...(cursor ? { cursor } : {}) };
        const res = await fetch("/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: ctl.signal,
        });
        if (mySeq !== seq.current) return;
        if (!res.ok) {
          const j = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
          if (j?.code === "term_too_short") { setSt({ kind: "hint", msg: j.error || "Уточніть запит" }); return; }
          setSt({ kind: "error", msg: j?.error || "Не вдалося виконати пошук" });
          return;
        }
        const data = (await res.json()) as SearchResponse;
        if (mySeq !== seq.current) return;
        reqSigRef.current = sig;
        setSt((prev) => {
          const base = append && prev.kind === "ready" ? prev.items : [];
          return { kind: "ready", items: [...base, ...data.items], nextCursor: data.nextCursor, hasMore: data.hasMore, loadingMore: false };
        });
      } catch (e) {
        if ((e as Error)?.name === "AbortError") return;
        if (mySeq !== seq.current) return;
        setSt({ kind: "error", msg: "Мережева помилка — спробуйте ще раз" });
      }
    },
    [buildRequest]
  );

  const hasAnyInput =
    term.trim().length > 0 || clinicId !== "all" || roomId !== "all" || period !== "all" ||
    status !== "all" || mods.length > 0 || contrast !== "any" || prio !== "all";

  // Дебаунс 350 мс на изменение любого условия; без условий — начальная подсказка.
  useEffect(() => {
    if (!clinics.length) return; // нет области — состояние «нет доступа» отрисовано ниже
    if (!hasAnyInput) { seq.current++; abortRef.current?.abort(); setSt({ kind: "idle" }); return; }
    // Условия изменились — старый курсор недействителен НЕМЕДЛЕННО (ревью MEDIUM-2):
    // иначе «Показати ще» в окне дебаунса пришивал бы к старому списку чужую страницу.
    setSt((s) => (s.kind === "ready" ? { ...s, nextCursor: null, hasMore: false } : { kind: "loading" }));
    const t = setTimeout(() => runSearch(false, null), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term, source, clinicId, roomId, period, dateFrom, dateTo, status, mods, contrast, prio, sortDesc]);

  function loadMore() {
    if (st.kind !== "ready" || !st.nextCursor) return;
    setSt({ ...st, loadingMore: true });
    runSearch(true, st.nextCursor);
  }

  function resetFilters() {
    setClinicId("all"); setRoomId("all"); setPeriod("all"); setDateFrom(""); setDateTo("");
    setStatus("all"); setMods([]); setContrast("any"); setPrio("all");
  }

  /* Chips активных фильтров: каждый удаляется по ✕. */
  type Chip = { key: string; lab: string; clear: () => void };
  const chips: Chip[] = [];
  if (clinicId !== "all") chips.push({ key: "clinic", lab: clinicsById[clinicId] || "Клініка", clear: () => setClinicId("all") });
  if (roomId !== "all") chips.push({ key: "room", lab: roomsById[roomId]?.name || "Кабінет", clear: () => setRoomId("all") });
  if (period === "today") chips.push({ key: "p", lab: "Сьогодні", clear: () => setPeriod("all") });
  if (period === "7") chips.push({ key: "p", lab: "±7 днів", clear: () => setPeriod("all") });
  if (period === "30") chips.push({ key: "p", lab: "±30 днів", clear: () => setPeriod("all") });
  if (period === "custom" && (dateFrom || dateTo))
    chips.push({ key: "p", lab: `${dateFrom ? fmtDate(dateFrom) : "…"} – ${dateTo ? fmtDate(dateTo) : "…"}`, clear: () => { setPeriod("all"); setDateFrom(""); setDateTo(""); } });
  if (status !== "all") chips.push({ key: "st", lab: (source === "queue" ? ST_QUEUE : ST_WL)[status] || status, clear: () => setStatus("all") });
  mods.forEach((m) => chips.push({ key: "m" + m, lab: MODS.find((x) => x.code === m)?.lab || m, clear: () => setMods((arr) => arr.filter((x) => x !== m)) }));
  if (contrast !== "any") chips.push({ key: "c", lab: contrast === "yes" ? "З контрастом" : "Без контрасту", clear: () => setContrast("any") });
  if (prio !== "all") chips.push({ key: "pr", lab: PRIO[prio] || prio, clear: () => setPrio("all") });

  const stMeta = source === "queue" ? ST_QUEUE : ST_WL;

  return (
    <div className="app" style={{ display: "block" }}>
      <div className="main">
        <header className="topbar">
          <div className="tb-title">
            <a href={backHref} className="btn btn-secondary btn-sm" style={{ marginRight: 10 }} aria-label="Назад">←</a>
            <span className="tic" aria-hidden="true">⌕</span>
            <div>
              <h1>Пошук</h1>
              <div className="date">Пацієнти та дослідження · {userName}</div>
            </div>
          </div>
        </header>

        <div className="content-full">
          <div className="page-max">
            {!clinics.length ? (
              <div className="empty">
                <div className="ei" aria-hidden="true">🔒</div>
                <div className="et">Немає доступних центрів</div>
                <div className="es">{roleKey === "referrer" ? "Запросіть доступ у центрі — після підтвердження пошук запрацює" : "Зверніться до адміністратора"}</div>
              </div>
            ) : (
              <>
                {/* Строка поиска + источники + фильтры */}
                <div className="qctrl" style={{ flexWrap: "wrap", gap: 8 }}>
                  {sources.length > 1 && (
                    <div className="pills" role="tablist" aria-label="Джерело пошуку">
                      <button role="tab" aria-selected={source === "queue"} className={"pill" + (source === "queue" ? " active" : "")} onClick={() => setSource("queue")}>Черга</button>
                      <button role="tab" aria-selected={source === "waitlist"} className={"pill" + (source === "waitlist" ? " active" : "")} onClick={() => setSource("waitlist")}>Лист очікування</button>
                    </div>
                  )}
                  <div className="search" style={{ flex: "1 1 260px" }}>
                    <span className="si" aria-hidden="true">⌕</span>
                    {/* Ввід НЕ канонізуємо (ревью HIGH-1): formatPhoneSearch зрізав ведучі
                        цифри і вбивав пошук за серединою/останніми цифрами номера; матчинг
                        на сервері цифровий, тож формат вводу не має значення. */}
                    <input
                      autoFocus
                      aria-label="Пацієнт або дослідження"
                      placeholder="Пацієнт, дослідження або ID запису…"
                      value={term}
                      onChange={(e) => setTerm(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && hasAnyInput) runSearch(false, null); }}
                    />
                    {term && (
                      <button type="button" className="mini-icon" aria-label="Очистити пошук" onClick={() => setTerm("")} style={{ flexShrink: 0 }}>✕</button>
                    )}
                  </div>
                  <button type="button" className="btn btn-secondary btn-sm" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((v) => !v)}>
                    ⚙ Фільтри{chips.length ? ` (${chips.length})` : ""}
                  </button>
                  <button
                    type="button" className="btn btn-secondary btn-sm"
                    onClick={() => setSortDesc((v) => !v)}
                    title="Порядок за датою" aria-label={"Сортування: " + (sortDesc ? "спочатку новіші" : "спочатку старіші")}
                  >
                    {sortDesc ? "↓ новіші" : "↑ старіші"}
                  </button>
                </div>

                {filtersOpen && (
                  <div className="card" style={{ padding: 12, marginTop: 8, display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
                    {clinics.length > 1 && (
                      <label style={{ display: "grid", gap: 4 }}>
                        <span className="cld-lab">Клініка</span>
                        <select className="inp" value={clinicId} onChange={(e) => setClinicId(e.target.value)}>
                          <option value="all">Усі клініки</option>
                          {clinics.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                      </label>
                    )}
                    {roomOpts.length > 0 && (
                      <label style={{ display: "grid", gap: 4 }}>
                        <span className="cld-lab">Кабінет</span>
                        <select className="inp" value={roomId} onChange={(e) => setRoomId(e.target.value)}>
                          <option value="all">Усі кабінети</option>
                          {roomOpts.map((r) => <option key={r.id} value={r.id}>{modalityLabel(r.modality)} · {r.name}</option>)}
                        </select>
                      </label>
                    )}
                    <div style={{ display: "grid", gap: 4 }}>
                      <span className="cld-lab" id="srch-period-lab">Період</span>
                      <div className="pills" role="group" aria-labelledby="srch-period-lab">
                        {([["all", "Весь час"], ["today", "Сьогодні"], ["7", "±7 днів"], ["30", "±30 днів"], ["custom", "Діапазон"]] as const).map(([k, lab]) => (
                          <button key={k} type="button" className={"pill" + (period === k ? " active" : "")} aria-pressed={period === k} onClick={() => setPeriod(k)}>{lab}</button>
                        ))}
                      </div>
                    </div>
                    {period === "custom" && (
                      <>
                        <label style={{ display: "grid", gap: 4 }}>
                          <span className="cld-lab">З</span>
                          <input className="inp tabular" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
                        </label>
                        <label style={{ display: "grid", gap: 4 }}>
                          <span className="cld-lab">До</span>
                          <input className="inp tabular" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
                        </label>
                      </>
                    )}
                    <label style={{ display: "grid", gap: 4 }}>
                      <span className="cld-lab">Статус</span>
                      <select className="inp" value={status} onChange={(e) => setStatus(e.target.value)}>
                        <option value="all">Усі статуси</option>
                        {Object.entries(stMeta).map(([k, lab]) => <option key={k} value={k}>{lab}</option>)}
                      </select>
                    </label>
                    <div style={{ display: "grid", gap: 4 }}>
                      <span className="cld-lab" id="srch-mod-lab">Модальність</span>
                      <div className="pills" role="group" aria-labelledby="srch-mod-lab">
                        {MODS.map((m) => (
                          <button key={m.code} type="button" aria-pressed={mods.includes(m.code)}
                            className={"pill" + (mods.includes(m.code) ? " active" : "")}
                            onClick={() => setMods((arr) => (arr.includes(m.code) ? arr.filter((x) => x !== m.code) : [...arr, m.code]))}>
                            {m.lab}
                          </button>
                        ))}
                      </div>
                    </div>
                    <label style={{ display: "grid", gap: 4 }}>
                      <span className="cld-lab">Контраст</span>
                      <select className="inp" value={contrast} onChange={(e) => setContrast(e.target.value as "any" | "yes" | "no")}>
                        <option value="any">Будь-який</option>
                        <option value="yes">З контрастом</option>
                        <option value="no">Без контрасту</option>
                      </select>
                    </label>
                    <label style={{ display: "grid", gap: 4 }}>
                      <span className="cld-lab">Пріоритет</span>
                      <select className="inp" value={prio} onChange={(e) => setPrio(e.target.value)}>
                        <option value="all">Будь-який</option>
                        <option value="cito">CITO</option>
                        <option value="urgent">Терміново</option>
                        <option value="planned">Планово</option>
                      </select>
                    </label>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={resetFilters}>Скинути фільтри</button>
                  </div>
                )}

                {chips.length > 0 && (
                  <div className="pills" style={{ marginTop: 8, flexWrap: "wrap" }} aria-label="Активні фільтри">
                    {chips.map((c) => (
                      <button key={c.key + c.lab} type="button" className="pill active" onClick={c.clear} aria-label={"Прибрати фільтр: " + c.lab}>
                        {c.lab} <span aria-hidden="true">✕</span>
                      </button>
                    ))}
                    <button type="button" className="pill" onClick={resetFilters}>Скинути всі</button>
                  </div>
                )}

                {/* Результаты */}
                <div style={{ marginTop: 14 }}>
                  {st.kind === "idle" && (
                    <div className="empty">
                      <div className="ei" aria-hidden="true">⌕</div>
                      <div className="et">Пошук по всій історії та майбутніх записах</div>
                      <div className="es">Введіть прізвище (повністю або частину), номер телефону (код оператора, середину чи останні цифри), назву дослідження — наприклад «МРТ мозок» — або ID запису з «Журналу дій». Фільтри звужують період, кабінет, статус.</div>
                    </div>
                  )}
                  {st.kind === "hint" && (
                    <div className="empty"><div className="ei" aria-hidden="true">✏️</div><div className="et">{st.msg}</div></div>
                  )}
                  {st.kind === "loading" && (
                    <div className="qrows" aria-busy="true" aria-label="Виконуємо пошук">
                      {[0, 1, 2].map((i) => <div key={i} className="qrow-item skel" style={{ height: 56 }} />)}
                    </div>
                  )}
                  {st.kind === "error" && (
                    <div className="empty">
                      <div className="ei" aria-hidden="true">⚠️</div>
                      <div className="et">Пошук не виконано</div>
                      <div className="es">{st.msg}</div>
                      <button className="btn btn-secondary btn-sm" style={{ marginTop: 10 }} onClick={() => runSearch(false, null)}>↻ Повторити</button>
                    </div>
                  )}
                  {st.kind === "ready" && st.items.length === 0 && (
                    <div className="empty">
                      <div className="ei" aria-hidden="true">📄</div>
                      <div className="et">Нічого не знайдено</div>
                      <div className="es">Змініть запит або зніміть фільтри{chips.length ? " (активних: " + chips.length + ")" : ""}</div>
                      {chips.length > 0 && <button className="btn btn-secondary btn-sm" style={{ marginTop: 10 }} onClick={resetFilters}>Скинути фільтри</button>}
                    </div>
                  )}
                  {st.kind === "ready" && st.items.length > 0 && (
                    <>
                      <div className="qrows" role="list" aria-label="Результати пошуку">
                        {st.items.map((it) => {
                          const room = it.roomId ? roomsById[it.roomId] : null;
                          const studies = it.studies.length
                            ? it.studies.map((s) => (s.type || "—") + (s.region ? " · " + s.region : "") + (s.contrast ? " · контраст" : "")).join(" + ")
                            : "—";
                          const inner = (
                            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", alignItems: "baseline", width: "100%" }}>
                              <div style={{ flex: "2 1 220px", minWidth: 0 }}>
                                <div style={{ fontWeight: 600 }}>
                                  {it.patientName}
                                  {it.caseId && <span title="Повʼязано з кейсом" aria-label="Кейс" style={{ marginLeft: 6 }}>🔗</span>}
                                  {it.priority !== "planned" && <span style={{ marginLeft: 8, color: it.priority === "cito" ? "#ff8c84" : "var(--orange)", fontSize: "0.85em" }}>{PRIO[it.priority]}</span>}
                                </div>
                                {showPhone && it.patientPhone && <div style={{ color: "var(--text-muted)", fontSize: "0.9em" }}>{it.patientPhone}</div>}
                              </div>
                              <div style={{ flex: "2 1 200px", minWidth: 0 }}>
                                <div>{studies}</div>
                                <div style={{ color: "var(--text-muted)", fontSize: "0.9em" }}>
                                  {clinics.length > 1 ? (clinicsById[it.clinicId] || "—") + " · " : ""}
                                  {room ? room.name : "—"}
                                  {showReferrerCol && it.referrerName ? " · напр.: " + it.referrerName : ""}
                                </div>
                              </div>
                              <div style={{ flex: "1 0 150px", textAlign: "right" }}>
                                <div className="tabular">{fmtDate(it.date)}{it.time ? " · " + it.time : ""}{it.isFuture ? " ↦" : ""}</div>
                                <div style={{ color: "var(--text-muted)", fontSize: "0.9em" }}>{stMeta[it.status] || it.status}{it.source === "waitlist" ? " · лист очікування" : ""}</div>
                              </div>
                            </div>
                          );
                          return it.href ? (
                            <a key={it.source + it.recordId} role="listitem" href={it.href} className="qrow-item" style={{ display: "flex", textDecoration: "none", color: "inherit", padding: "10px 12px" }}
                              aria-label={`Відкрити запис: ${it.patientName}, ${fmtDate(it.date)}`}>
                              {inner}
                            </a>
                          ) : (
                            <div key={it.source + it.recordId} role="listitem" className="qrow-item" style={{ display: "flex", padding: "10px 12px" }}>{inner}</div>
                          );
                        })}
                      </div>
                      {st.hasMore && (
                        <div style={{ textAlign: "center", marginTop: 12 }}>
                          <button className="btn btn-secondary btn-sm rf-spin-host" disabled={st.loadingMore} aria-busy={st.loadingMore} onClick={loadMore}>
                            {st.loadingMore ? "…" : "Показати ще"}
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
