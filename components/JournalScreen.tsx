"use client";

/* ===== RadFlow — «Журнал дій» (с25, ТЗ §11) =====

   Екран адміністратора: стрічка важливих подій центру з фільтрами
   (період, співробітник, тип події, ID запису) і догрузкою «Показати ще».

   Джерело — POST /api/journal (RLS-клієнт сесії на сервері). Клієнт НЕ
   задає ні клініку, ні сортування: область рахує сервер.

   ІМЕНА. У журналі імен немає за побудовою (0128) — тут вони резолвляться
   ОКРЕМО за actor_id під чинною RLS (ТЗ §11). Якщо ім'я недоступне
   (акаунт видалено / інша клініка) — показуємо роль і скорочений ID,
   а не «невідомо».

   Захисти запиту — ті самі три, що в SearchScreen: лічильник поколінь,
   AbortController і підпис запиту (щоб «Показати ще» не пришив сторінку
   від інших фільтрів). */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Sidebar from "@/components/Sidebar";
import LiveClock from "@/components/LiveClock";
import { createClient } from "@/lib/supabase/client";
import { setClinicTz, wallDayKey } from "@/lib/incidents";
import { visibleRooms } from "@/lib/rooms";
import {
  ALL_EVENT_TYPES,
  ACTOR_SYSTEM,
  type JournalItem,
  type JournalRequest,
  type JournalResponse,
} from "@/lib/journalContract";
import type { ImportantEventType } from "@/lib/importantEvents";
import {
  EVENT_TYPE_GROUPS,
  actorRoleLabel,
  entityLabel,
  eventDotClass,
  eventTitle,
  eventTypeLabel,
  fmtInstant,
  shortId,
} from "@/lib/journalText";
// Стилі прототипу — без цих імпортів сторінка рендериться голим HTML
// (спіймано живою перевіркою с22). Рівно ті самі два, що в усіх екранах.
import "@/styles/prototype/radflow.css";
import "@/styles/prototype/radflow-screens.css";

type RoomLite = { id: string; name: string; modality: string; apparatus_model?: string | null; active?: boolean };
type StaffLite = { id: string; name: string; role: string };

type UiState =
  | { kind: "loading" }
  | { kind: "error"; msg: string }
  | { kind: "ready"; items: JournalItem[]; nextCursor: string | null; hasMore: boolean; loadingMore: boolean };

type Period = "7" | "30" | "90" | "custom";

/** 'YYYY-MM-DD' ± n діб у настінному календарі (без TZ-арифметики). */
function shiftDay(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function JournalScreen({
  clinicName,
  clinicTz,
  adminName,
  rooms,
  staff,
}: {
  clinicName: string;
  clinicTz?: string;
  adminName: string;
  rooms: RoomLite[];
  staff: StaffLite[];
}) {
  // Зона центру — синхронно до першого рендера (інваріант проєкту).
  if (typeof window !== "undefined") setClinicTz(clinicTz);

  const today = wallDayKey(clinicTz);

  const [period, setPeriod] = useState<Period>("7");
  const [dateFrom, setDateFrom] = useState(shiftDay(today, -6));
  const [dateTo, setDateTo] = useState(today);
  const [actor, setActor] = useState<string>("all");
  /** "all" або конкретний ImportantEventType (групи — лише як optgroup). */
  const [eventType, setEventType] = useState<string>("all");
  const [entityId, setEntityId] = useState("");
  const [st, setSt] = useState<UiState>({ kind: "loading" });
  const [names, setNames] = useState<Record<string, string>>({});

  /* Період-пресети рахуємо від «сьогодні» центру, не браузера. */
  const range = useMemo(() => {
    if (period === "custom") return { from: dateFrom, to: dateTo };
    const days = Number(period);
    return { from: shiftDay(today, -(days - 1)), to: today };
  }, [period, dateFrom, dateTo, today]);

  /** Обраний тип як масив для контракту; "all" → без фільтра типів. */
  const selectedTypes = useMemo<ImportantEventType[] | undefined>(() => {
    if (eventType === "all") return undefined;
    const t = ALL_EVENT_TYPES.find((x) => x === eventType);
    return t ? [t] : undefined;
  }, [eventType]);

  /** Типи, згруповані для optgroup (порядок груп — з lib/journalText). */
  const groupedTypes = useMemo(
    () =>
      EVENT_TYPE_GROUPS.map((g) => ({
        label: g.label,
        types: ALL_EVENT_TYPES.filter((t) => g.match(t)),
      })).filter((g) => g.types.length > 0),
    []
  );

  const entityIdValid = entityId.trim() === "" || UUID_RE.test(entityId.trim());

  const buildRequest = useCallback((): JournalRequest => {
    const body: JournalRequest = { dateFrom: range.from, dateTo: range.to };
    if (actor !== "all") body.actor = actor;
    if (selectedTypes?.length) body.eventTypes = selectedTypes;
    const id = entityId.trim();
    if (id && UUID_RE.test(id)) body.entityId = id;
    return body;
  }, [range.from, range.to, actor, selectedTypes, entityId]);

  const seq = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const reqSigRef = useRef("");

  const run = useCallback(
    async (append: boolean, cursor: string | null) => {
      const base = buildRequest();
      const sig = JSON.stringify(base);
      // Догрузка валідна лише для тих умов, за яких отримано курсор.
      // Скидаємо «…» ДО раннього виходу — інакше кнопка лишалась би
      // задизейбленою назавжди (ревʼю с25 раунд 2 #9).
      if (append && sig !== reqSigRef.current) {
        setSt((s) => (s.kind === "ready" ? { ...s, loadingMore: false } : s));
        return;
      }
      const mySeq = ++seq.current;
      abortRef.current?.abort();
      const ctl = new AbortController();
      abortRef.current = ctl;
      if (!append) setSt((s) => (s.kind === "ready" ? { ...s, loadingMore: false } : s));
      try {
        const body: JournalRequest = { ...base, ...(cursor ? { cursor } : {}) };
        const res = await fetch("/api/journal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: ctl.signal,
        });
        if (mySeq !== seq.current) return;
        if (!res.ok) {
          const j = (await res.json().catch(() => null)) as { error?: string } | null;
          setSt({ kind: "error", msg: j?.error || "Не вдалося прочитати журнал" });
          return;
        }
        const data = (await res.json()) as JournalResponse;
        if (mySeq !== seq.current) return;
        reqSigRef.current = sig;
        setSt((prev) => {
          const head = append && prev.kind === "ready" ? prev.items : [];
          return {
            kind: "ready",
            items: [...head, ...data.items],
            nextCursor: data.nextCursor,
            hasMore: data.hasMore,
            loadingMore: false,
          };
        });
      } catch (e) {
        if ((e as Error)?.name === "AbortError") return;
        if (mySeq !== seq.current) return;
        setSt({ kind: "error", msg: "Мережева помилка — спробуйте ще раз" });
      }
    },
    [buildRequest]
  );

  /* Підпис ЕФЕКТИВНОГО запиту: поки в полі ID набирають uuid, тіло запиту не
     змінюється — і ми не шлемо 36 однакових запитів (ревʼю с25 LOW-9: з
     лімітом 60/хв на цьому реально було впертись у 429). */
  const reqSig = JSON.stringify(buildRequest());

  useEffect(() => {
    // Умови змінились — старий курсор недійсний НЕГАЙНО.
    setSt((s) => (s.kind === "ready" ? { ...s, nextCursor: null, hasMore: false } : { kind: "loading" }));
    const t = setTimeout(() => run(false, null), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reqSig]);

  /* Імена акторів — окремим запитом за id під RLS (ТЗ §11: журнал імен не
     дублює). Просимо лише ті id, яких ще не знаємо. */
  useEffect(() => {
    if (st.kind !== "ready") return;
    const need = Array.from(
      new Set(
        st.items
          .flatMap((i) => [i.actorId, i.subjectReferrerId])
          .filter((v): v is string => v != null && !(v in names))
      )
    );
    if (need.length === 0) return;
    let alive = true;
    (async () => {
      const supabase = createClient();
      const { data } = await supabase.from("profiles").select("id, full_name").in("id", need);
      if (!alive) return;
      setNames((prev) => {
        const next = { ...prev };
        // Кладемо і НЕрезолвлені id (порожній рядок), щоб не питати їх щоразу.
        for (const id of need) next[id] = "";
        for (const p of data ?? []) next[p.id] = (p.full_name as string) ?? "";
        return next;
      });
    })();
    return () => {
      alive = false;
    };
  }, [st, names]);

  function loadMore() {
    if (st.kind !== "ready" || !st.nextCursor) return;
    setSt({ ...st, loadingMore: true });
    run(true, st.nextCursor);
  }

  function resetFilters() {
    setPeriod("7");
    setActor("all");
    setEventType("all");
    setEntityId("");
  }

  /** Підпис актора: ім'я, якщо доступне; інакше роль + короткий ID. */
  function actorLabel(it: JournalItem): string {
    if (!it.actorId) return actorRoleLabel("system");
    const n = names[it.actorId];
    return n || `${actorRoleLabel(it.actorRole)} · ${shortId(it.actorId)}`;
  }

  const staffOpts = useMemo(
    () => [...staff].sort((a, b) => (a.name || "").localeCompare(b.name || "", "uk")),
    [staff]
  );

  const chips: { key: string; lab: string; clear: () => void }[] = [];
  if (period !== "7") chips.push({ key: "p", lab: period === "custom" ? `${dateFrom} — ${dateTo}` : `${period} днів`, clear: () => setPeriod("7") });
  if (actor !== "all") {
    const lab = actor === ACTOR_SYSTEM ? "Система" : (staffOpts.find((s) => s.id === actor)?.name || "Співробітник");
    chips.push({ key: "a", lab, clear: () => setActor("all") });
  }
  if (eventType !== "all") {
    chips.push({ key: "t", lab: eventTypeLabel(eventType as ImportantEventType), clear: () => setEventType("all") });
  }
  if (entityId.trim()) chips.push({ key: "e", lab: `ID ${shortId(entityId.trim())}`, clear: () => setEntityId("") });

  return (
    <div className="app">
      <Sidebar
        clinicName={clinicName}
        adminName={adminName}
        adminRole="Адміністратор"
        roleKey="admin"
        rooms={visibleRooms(rooms)}
        activeNav="journal"
      />
      <div className="main">
        <header className="topbar">
          <div className="tb-title">
            <span className="tic" aria-hidden="true">🗒</span>
            <div>
              <h1>Журнал дій</h1>
              <div className="date">{clinicName} · <LiveClock tz={clinicTz} /></div>
            </div>
          </div>
        </header>

        <div className="content-full">
          <div className="page-max">
            {/* ---------- фільтри ---------- */}
            <div className="form-card" style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
              <div style={{ display: "grid", gap: 4 }}>
                <span className="cld-lab" id="jr-period-lab">Період</span>
                <div className="pills" role="group" aria-labelledby="jr-period-lab">
                  {([["7", "7 днів"], ["30", "30 днів"], ["90", "90 днів"], ["custom", "Діапазон"]] as const).map(([k, lab]) => (
                    <button
                      key={k}
                      type="button"
                      className={"pill" + (period === k ? " active" : "")}
                      aria-pressed={period === k}
                      onClick={() => setPeriod(k)}
                    >
                      {lab}
                    </button>
                  ))}
                </div>
              </div>

              {period === "custom" && (
                <>
                  <label style={{ display: "grid", gap: 4 }}>
                    <span className="cld-lab">З</span>
                    <input className="inp tabular" type="date" value={dateFrom} max={dateTo} onChange={(e) => setDateFrom(e.target.value)} />
                  </label>
                  <label style={{ display: "grid", gap: 4 }}>
                    <span className="cld-lab">До</span>
                    <input className="inp tabular" type="date" value={dateTo} min={dateFrom} onChange={(e) => setDateTo(e.target.value)} />
                  </label>
                </>
              )}

              <label style={{ display: "grid", gap: 4 }}>
                <span className="cld-lab">Співробітник</span>
                <select className="inp" value={actor} onChange={(e) => setActor(e.target.value)}>
                  <option value="all">Усі</option>
                  <option value={ACTOR_SYSTEM}>Система (авто)</option>
                  {staffOpts.map((s) => (
                    <option key={s.id} value={s.id}>{s.name || shortId(s.id)}</option>
                  ))}
                </select>
              </label>

              <label style={{ display: "grid", gap: 4 }}>
                <span className="cld-lab">Тип події</span>
                <select className="inp" value={eventType} onChange={(e) => setEventType(e.target.value)} style={{ minWidth: 260 }}>
                  <option value="all">Усі типи</option>
                  {groupedTypes.map((g) => (
                    <optgroup key={g.label} label={g.label}>
                      {g.types.map((t) => (
                        <option key={t} value={t}>{eventTypeLabel(t)}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>

              <label style={{ display: "grid", gap: 4 }}>
                <span className="cld-lab">ID запису / кейса</span>
                <input
                  className="inp tabular"
                  value={entityId}
                  onChange={(e) => setEntityId(e.target.value)}
                  placeholder="uuid"
                  aria-invalid={!entityIdValid}
                  aria-describedby={entityIdValid ? undefined : "jr-id-err"}
                  style={{ minWidth: 260, ...(entityIdValid ? {} : { borderColor: "var(--red)" }) }}
                />
              </label>

              {entityId.trim() && !entityIdValid && (
                <div className="es" id="jr-id-err" style={{ color: "var(--red)", flexBasis: "100%" }}>
                  ID має бути повним uuid — інакше фільтр не застосовується
                </div>
              )}
            </div>

            {chips.length > 0 && (
              <div className="pills" style={{ marginTop: 8, flexWrap: "wrap" }} role="group" aria-label="Активні фільтри">
                {chips.map((c) => (
                  <button key={c.key} type="button" className="pill active" onClick={c.clear} aria-label={"Прибрати фільтр: " + c.lab}>
                    {c.lab} <span aria-hidden="true">✕</span>
                  </button>
                ))}
                <button type="button" className="pill" onClick={resetFilters}>Скинути всі</button>
              </div>
            )}

            {/* ---------- стрічка ---------- */}
            <div style={{ marginTop: 16 }}>
              {st.kind === "loading" && (
                <div className="qrows" role="status" aria-busy="true" aria-label="Читаємо журнал">
                  {[0, 1, 2].map((i) => <div key={i} className="qrow-item skel" style={{ height: 52 }} />)}
                </div>
              )}

              {st.kind === "error" && (
                <div className="empty">
                  <div className="ei" aria-hidden="true">⚠️</div>
                  <div className="et">Журнал не прочитано</div>
                  <div className="es">{st.msg}</div>
                  <button className="btn btn-secondary btn-sm" style={{ marginTop: 10 }} onClick={() => run(false, null)}>
                    ↻ Повторити
                  </button>
                </div>
              )}

              {st.kind === "ready" && st.items.length === 0 && (
                <div className="empty">
                  <div className="ei" aria-hidden="true">🗒</div>
                  <div className="et">Подій не знайдено</div>
                  <div className="es">
                    Змініть період або зніміть фільтри{chips.length ? ` (активних: ${chips.length})` : ""}
                  </div>
                  {chips.length > 0 && (
                    <button className="btn btn-secondary btn-sm" style={{ marginTop: 10 }} onClick={resetFilters}>
                      Скинути фільтри
                    </button>
                  )}
                </div>
              )}

              {st.kind === "ready" && st.items.length > 0 && (
                <div className="timeline">
                  {st.items.map((it) => (
                    <div className="tl-item" key={it.id}>
                      <span className={"tl-dot " + eventDotClass(it.eventType)} aria-hidden="true" />
                      <div className="tl-time tabular">{fmtInstant(it.occurredAt, clinicTz)}</div>
                      <div className="tl-title">
                        {eventTitle({
                          eventType: it.eventType,
                          actorRole: it.actorRole,
                          changedFields: it.changedFields,
                          details: it.details,
                        })}
                      </div>
                      <div className="tl-sub">
                        {actorLabel(it)}
                        {" · "}
                        {entityLabel(it.entityType)}{" "}
                        <span className="tabular" title={it.entityId}>{shortId(it.entityId)}</span>
                        {/* Направника показуємо, лише коли він НЕ той самий, хто діяв:
                            інакше рядок дублює сам себе («Направник … направник: …»). */}
                        {it.subjectReferrerId && it.subjectReferrerId !== it.actorId && (
                          <>
                            {" · направник: "}
                            {names[it.subjectReferrerId] || shortId(it.subjectReferrerId)}
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {st.kind === "ready" && st.hasMore && (
                <div style={{ textAlign: "center", marginTop: 12 }}>
                  <button
                    className="btn btn-secondary btn-sm"
                    disabled={st.loadingMore}
                    aria-busy={st.loadingMore}
                    onClick={loadMore}
                  >
                    {st.loadingMore ? "…" : "Показати ще"}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
