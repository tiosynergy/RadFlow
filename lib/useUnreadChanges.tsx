"use client";

/**
 * Спільний шар даних для контекстних позначок непрочитаних змін (0131/0132).
 *
 * ОДИН пакетний запит на вкладку + індексовані селектори (ТЗ прямо забороняє
 * запит на кожну картку). Realtime — лише низьколатентний СИГНАЛ; джерело
 * істини — БД, тому кожен сигнал веде до перечитування, а не до злиття
 * payload-у (той самий принцип, що в useRealtimeRefetch).
 *
 * ⚠️ ЧОМУ МОДУЛЬНИЙ STORE, А НЕ REACT-КОНТЕКСТ (ревʼю р1, H-4).
 * Перша редакція жила на Provider-і, змонтованому в QueueBoard. Але Sidebar
 * рендерять ЩЕ ВІСІМ екранів (WaitlistBoard, ServicesManager, CallListBoard,
 * StaffManager, JournalScreen, ReferrersManager, CeoDashboard, CeoManager) —
 * і на всіх них контекст був порожній: у боковій панелі горіла крапка «Лист
 * очікування», користувач переходив туди, а там ані крапок, ані ack —
 * крапка не гасла НІКОЛИ. Store поза React знімає питання «а хто тут
 * обгорнув»: підписку тримає <UnreadChangesMount /> усередині сайдбарів
 * (вони є на кожному робочому екрані), а читати стан може будь-хто.
 *
 * ⚠️ Індекс живе В САМОМУ STORE і перераховується один раз на оновлення
 * (ревʼю р2, M-8new): useUnreadChanges() викликається в КОЖНОМУ рядку дошки,
 * і перерахунок індексу в хуку означав би 2×N повних проходів по пакету на
 * кожен тик звірки. З тієї ж причини reloadMarkers НЕ публікує новий стан,
 * якщо дані не змінились (відбиток id+created_at) — інакше кожні 60 с уся
 * дошка ререндерилась би на рівному місці.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSyncExternalStore } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";
import {
  ackIdsForScope, EMPTY_INDEX, indexMarkers, snapshotIdsOf,
  type AckScope, type ChangeMarker, type UnreadIndex, type UnreadStatus,
} from "@/lib/unreadChanges";

/** Стеля пакета. Непрочитаного в нормі десятки. */
const FETCH_LIMIT = 500;

/** Рідка звірка при живому сокеті (с26, H-3B). Таблиця крихітна. */
const RECONCILE_MS = 60_000;

/* ⚠️ ПАУЗА МІЖ РЕТРАЯМИ ack (пакет №4, с29).
   ackFailGen перевзводить УСІ видимі useAckWhenVisible одразу, і при СТІЙКІЙ
   помилці (протухла сесія → 401, відкликаний грант, впала БД) виходив
   безперервний цикл: невдача → перевзвід → N запитів → N невдач → перевзвід.
   Швидкість обмежувала лише мережа, і на дошці з десятком розгорнутих рядків
   це десятки запитів на секунду до кінця сесії.
   Тепер невдача НЕ будить хуки одразу: вона заводить ОДИН таймер на весь
   модуль, і лише його спрацювання інкрементує ackFailGen. Стійка помилка
   впирається в стелю 60 с.
   ⚠️ Чесно про різницю з р2/L-10new: там ретрай був МИТТЄВИЙ, тут перший крок
   ~1 с (плюс джиттер). Для транзієнтної помилки це той самий сценарій із
   затримкою в секунду. Сходинка згасає ЗА ЧАСОМ (див. scheduleAckRetry), а не
   від успіху сусіднього хука чи від успішного select — інакше стеля була б
   недосяжною.
   ⚠️ Імпульс може пропасти: якщо на момент спрацювання таймера жоден хук не
   може зробити ack (status ≠ 'ready', блок згорнули, компонент розмонтували),
   новий таймер ніхто не заведе. Це прийнято свідомо — відновлення дає сама
   зміна status/видимості (обидві в депсах ефекту), а планувати ретрай «у
   порожнечу» означало б вічний тикер у фоні.
   Порядок кроків — мілісекунди. */
const ACK_RETRY_MS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000] as const;

type StoreState = {
  markers: ChangeMarker[];
  index: UnreadIndex;
  status: UnreadStatus;
  snapshotIds: ReadonlySet<string>;
  /** Уперлись у ліміт вибірки: частина непрочитаного НЕ показана.
      Це діагностика зламаного ack, а не нормальний режим. */
  truncated: boolean;
  userId: string | null;
  /** Росте на невдалому mark_changes_seen — перевзводить useAckWhenVisible
      (ревʼю р2, L-10new: без цього транзієнтна помилка мережі лишала крапку
      на відкритому блоці до ручного згортання/розгортання). */
  ackFailGen: number;
};

const EMPTY_SET: ReadonlySet<string> = new Set<string>();

let state: StoreState = {
  markers: [],
  index: EMPTY_INDEX,
  status: "loading",
  snapshotIds: EMPTY_SET,
  truncated: false,
  userId: null,
  ackFailGen: 0,
};

const listeners = new Set<() => void>();

function setState(patch: Partial<StoreState>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => { listeners.delete(l); };
};
const getSnapshot = (): StoreState => state;
// SSR: сервер завжди бачить «завантаження без крапок» — гідрація без розбіжностей.
const getServerSnapshot = (): StoreState => state;

/* Лічильник поколінь на рівні МОДУЛЯ. Без нього швидка послідовність
   «realtime → фокус → полінг» приводить три відповіді в довільному порядку,
   і найстаріша може лягти останньою. Правило проєкту з с24, яке с26 довелось
   окремо доносити до хуків (useRoomBusy жив без нього). */
let gen = 0;

/** Відбиток пакета: id + created_at (згортання оновлює created_at, тож зміна
    severity/полів усередині наявного рядка відбиток теж міняє). */
const fingerprintOf = (rows: readonly ChangeMarker[]): string =>
  rows.map((m) => m.id + m.created_at).join("|");

let lastFingerprint = "";

async function reloadMarkers(): Promise<void> {
  const my = ++gen;
  try {
    const supabase = createClient();
    const uid = state.userId;
    let q = supabase
      .from("user_change_markers")
      .select(
        "id, clinic_id, event_type, surface_key, entity_type, entity_id, field_scope," +
        " actor_id, actor_role, subject_referrer_id, room_id, severity, changed_fields," +
        " details, created_at, seen_at, subject_date"
      )
      .is("seen_at", null);
    /* Фільтр по отримувачу — defense-in-depth і підказка планувальнику на
       ucm_recipient_unread_idx. Межа безпеки — RLS-політика ucm_read_own. */
    if (uid) q = q.eq("recipient_id", uid);

    const { data, error } = await q.order("created_at", { ascending: false }).limit(FETCH_LIMIT);
    if (my !== gen) return;                       // чуже покоління

    if (error) {
      // fail-CLOSED: попередні позначки лишаються, нуль не підставляємо.
      setState({ status: state.status === "loading" ? "loading" : "error-with-previous-data" });
      return;
    }
    const rows = (data ?? []) as unknown as ChangeMarker[];
    const fp = fingerprintOf(rows);
    if (fp === lastFingerprint && state.status === "ready") {
      return;                                     // нічого не змінилось — не будимо підписників
    }
    lastFingerprint = fp;
    setState({
      markers: rows,
      index: indexMarkers(rows),                  // один перерахунок на оновлення
      snapshotIds: snapshotIdsOf(rows),           // знімок оновлює лише УСПІХ
      status: "ready",
      truncated: rows.length >= FETCH_LIMIT,
    });
  } catch {
    if (my !== gen) return;
    setState({ status: state.status === "loading" ? "loading" : "error-with-previous-data" });
  }
}

/**
 * Підтвердити прочитання. Час ставить БД; RPC повертає id, які РЕАЛЬНО
 * оновились, і гасимо ми саме їх (сценарій 2 ТЗ: друга вкладка отримає
 * порожній список і нічого зайвого не прибере).
 */
/* Стан backoff-у: лічильник послідовних невдач, час останньої невдачі і
   ЄДИНИЙ таймер на модуль. Таймер один навмисно: невдача приходить від
   кожного видимого хука окремо, а розбудити їх треба разом. */
let ackFails = 0;
let ackLastFailAt = 0;
let ackRetryTimer: ReturnType<typeof setTimeout> | null = null;

/* Джиттер — те саме правило, що в useRealtimeRefetch (техаудит Medium-1):
   при масовому 401 (JWT протух за однаковим TTL, рестарт Supabase) усі
   вкладки впали б одночасно і ретраїли б в унісон на кожній сходинці. */
const jittered = (ms: number): number => Math.round(ms * (0.75 + Math.random() * 0.5));

/**
 * Невдалий ack: завести (або лишити) паузу перед спільним перевзводом.
 *
 * ⚠️ СХОДИНКА ЗГАСАЄ ЗА ЧАСОМ, А НЕ ВІД ЧУЖОГО УСПІХУ (ревʼю р2, B-1new).
 * Лічильник один на модуль, а хуки падають НЕЗАЛЕЖНО: `ackFailGen` будить усіх
 * одночасно, тож у кожному раунді успіхи й невдачі приходять разом. Перша
 * редакція обнуляла лічильник на будь-якому успіху — і десять рядків, чий ack
 * пройшов, щоразу повертали панель простоїв, чий ack стійко падає, на першу
 * сходинку. Стеля 60 с ставала недосяжною, а частота — ~10 запитів/с на
 * вкладку, тобто вихідний дефект. З тієї ж причини сходинку НЕ скидає
 * успішний `reloadMarkers`: select і RPC — різні канали, і «select живий»
 * нічого не каже про доступність `mark_changes_seen` (ревʼю р2, B-2new).
 * Замість цього — просте згасання: якщо з моменту останньої невдачі минуло
 * більше двох стель, серія вважається завершеною і відлік іде з нуля.
 */
function scheduleAckRetry(): void {
  const now = Date.now();
  if (ackFails > 0 && now - ackLastFailAt > ACK_RETRY_MS[ACK_RETRY_MS.length - 1] * 2) {
    ackFails = 0;                                // попередня серія давно скінчилась
  }
  ackLastFailAt = now;
  if (ackRetryTimer !== null) return;            // пауза вже йде — не подовжуємо
  const delay = jittered(ACK_RETRY_MS[Math.min(ackFails, ACK_RETRY_MS.length - 1)]);
  ackFails = Math.min(ackFails + 1, ACK_RETRY_MS.length);
  ackRetryTimer = setTimeout(() => {
    ackRetryTimer = null;
    setState({ ackFailGen: state.ackFailGen + 1 });   // перевзвід ретраю — РІВНО раз
  }, delay);
}

/** Контекст змінився цілком (інший користувач) — гасити вже нічого. */
function clearAckBackoff(): void {
  ackFails = 0;
  ackLastFailAt = 0;
  if (ackRetryTimer !== null) { clearTimeout(ackRetryTimer); ackRetryTimer = null; }
}

async function ackMarkerIds(ids: readonly string[]): Promise<void> {
  if (!ids.length) return;
  /* Покоління знімаємо ДО запиту (ревʼю р2): відповідь може прийти вже після
     resetForUser, і тоді ані чіпати backoff, ані писати markers чужої сесії
     не можна — у другому випадку індекс нового користувача перезбирався б із
     залишків попереднього. */
  const my = gen;
  try {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("mark_changes_seen", { p_ids: ids as string[] });
    if (my !== gen) return;
    if (error) {
      scheduleAckRetry();
      return;
    }
    const acked = new Set(((data ?? []) as Array<{ marker_id: string }>).map((r) => r.marker_id));
    if (!acked.size) return;
    const rest = state.markers.filter((m) => !acked.has(m.id));
    lastFingerprint = fingerprintOf(rest);
    setState({ markers: rest, index: indexMarkers(rest) });
  } catch {
    if (my !== gen) return;
    scheduleAckRetry();
  }
}

function resetForUser(id: string | null): void {
  gen += 1;
  lastFingerprint = "";
  /* Зміна користувача (релогін, вихід) — інша сесія й інші права: сходинки
     попередньої НЕ успадковуємо, інакше перший ack нового користувача чекав
     би хвилину через чужі невдачі. Заморожений таймер теж знімаємо. */
  clearAckBackoff();
  setState({
    markers: [], index: EMPTY_INDEX, snapshotIds: EMPTY_SET,
    status: "loading", truncated: false, userId: id,
  });
}

/* ⚠️ ВЛАСНИК ПІДПИСКИ. Кілька <UnreadChangesMount /> у ОДНОМУ дереві —
   реальний сценарій (майстер /setup монтує свій, а вкладений
   ReferrersManager — свій), і без цього лічильника вони падали в рантаймі:
   канал іменований по userId, тож обидва брали ОДИН канал Supabase, а другий
   викликав .on("postgres_changes") уже ПІСЛЯ .subscribe() першого —
   «cannot add postgres_changes callbacks ... after subscribe()» (жива
   перевірка с28). Тепер підписку тримає ПЕРШИЙ змонтований екземпляр,
   решта — пасивні (channelName = null) і живуть із того ж модульного стану.
   Звільнення в cleanup дозволяє наступному стати власником — це важливо для
   StrictMode (маунт → розмонтування → маунт) і для випадку, коли зникає саме
   власник, а пасивний лишається. */
let mountOwner: symbol | null = null;
/* Черга очікувачів. Без неї інваріант «підписка є у КОГОСЬ» тримався лише на
   порядку коміту ефектів: якщо власником ставав вкладений маунт і саме він
   зникав першим (умовний рендер секції), пасивні лишались з isOwner=false
   НАЗАВЖДИ — дерево без підписки, без звірки і без первинного завантаження,
   status застряє в 'loading', а useAckWhenVisible вимагає 'ready' → мовчки
   вимикається вся фіча, візуально невідрізнянно від «усе прочитано»
   (ревʼю с28-р3). Тепер звільнення власника промотує наступного. */
const mountWaiters = new Map<symbol, (v: boolean) => void>();

/**
 * Тримає підписку і завантаження. Рендериться в сайдбарах (Sidebar,
 * ReferrerSidebar, панель радіолога) і в майстрі налаштувань, де сайдбара
 * немає. Нічого не малює. Кілька одночасних маунтів безпечні — див. коментар
 * про mountOwner вище.
 */
export function UnreadChangesMount(): null {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const userId = snap.userId;

  const idRef = useRef<symbol | null>(null);
  if (idRef.current === null) idRef.current = Symbol("unread-mount");
  const [isOwner, setIsOwner] = useState(false);
  useEffect(() => {
    const me = idRef.current!;
    mountWaiters.set(me, setIsOwner);
    if (mountOwner === null) { mountOwner = me; setIsOwner(true); }
    return () => {
      mountWaiters.delete(me);
      if (mountOwner !== me) return;
      mountOwner = null;
      setIsOwner(false);
      const next = mountWaiters.entries().next().value;   // будь-який живий маунт
      if (next) { mountOwner = next[0]; next[1](true); }
    };
  }, []);

  /* ⚠️ Не одноразовий getUser() (ревʼю р1, M-8). Транзієнтний «Failed to
     fetch» на маунті раніше назавжди вимикав фічу: userId лишався null,
     channelName — null, і статус застигав у 'loading' — візуально
     НЕВІДРІЗНЯЛЬНО від «усе прочитано». Тепер: разовий запит + підписка на
     зміну сесії (вона ж покриває вхід іншим користувачем у тій самій
     вкладці). ⚠️ Побічні ефекти — у тілі колбеків, НЕ в updater-і setState
     (ревʼю р2, M-7new: StrictMode двоїть updater-и, і gen ріс двічі). */
  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();

    const apply = (id: string | null) => {
      if (cancelled) return;
      if (state.userId === id) return;
      resetForUser(id);        // зміна користувача = повне скидання чужих крапок
    };

    (async () => {
      try {
        const { data } = await supabase.auth.getUser();
        apply(data.user?.id ?? null);
      } catch {
        /* лишаємо як є — підписка нижче дотягне сесію, коли мережа оживе */
      }
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      apply(session?.user?.id ?? null);
    });
    return () => { cancelled = true; sub.subscription.unsubscribe(); };
  }, []);

  const subs = useMemo(
    () =>
      userId
        ? [{
            table: "user_change_markers",
            filter: `recipient_id=eq.${userId}`,
            onChange: () => { void reloadMarkers(); },
            debounceKey: "unread",
          }]
        : [],
    [userId]
  );

  useRealtimeRefetch({
    // Підписку тримає лише власник (див. mountOwner): пасивні екземпляри
    // передають null і жодного каналу не відкривають.
    channelName: isOwner && userId ? `unread-markers:${userId}` : null,
    subscriptions: isOwner ? subs : [],
    pollWhenSubscribedMs: RECONCILE_MS,
  });

  /* Первинне завантаження робить сам useRealtimeRefetch (callAll на маунті),
     але лише коли є channelName. Дублюємо явно на випадок, якщо userId
     зʼявився пізніше за маунт. Тільки у власника: пасивні читають той самий
     модульний стан, а їхні запити були б точними дублями (ревʼю с28-р3). */
  useEffect(() => {
    if (!isOwner || !userId) return;
    void reloadMarkers();
  }, [isOwner, userId]);

  return null;
}

export type UnreadChangesApi = {
  index: UnreadIndex;
  status: UnreadStatus;
  snapshotIds: ReadonlySet<string>;
  truncated: boolean;
  reload: () => void;
  ack: (scope: AckScope) => Promise<void>;
  ackIds: (ids: readonly string[]) => Promise<void>;
};

/** Читає стан позначок. Працює в будь-якому місці дерева — провайдер не потрібен. */
export function useUnreadChanges(): UnreadChangesApi {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const ack = useCallback(
    async (scope: AckScope) => {
      // Читаємо АКТУАЛЬНИЙ стан на момент кліку, а не замикання рендеру.
      await ackMarkerIds(ackIdsForScope(state.index, scope, state.snapshotIds));
    },
    []
  );

  return {
    index: snap.index,
    status: snap.status,
    snapshotIds: snap.snapshotIds,
    truncated: snap.truncated,
    reload: () => { void reloadMarkers(); },
    ack,
    ackIds: ackMarkerIds,
  };
}

/**
 * Підтвердити прочитання, КОЛИ блок реально показано.
 *
 * ⚠️ Не «на клік по навігації» і не «на відкриття сторінки» (ТЗ це прямо
 * забороняє): хук чекає на `visible` — прапорець, який компонент вмикає лише
 * після того, як дані успішно завантажились І блок відрендерився. Поки
 * картка згорнута, а блок прихований — позначка лишається непрочитаною.
 *
 * ⚠️ ЗНІМОК ЗАМОРОЖУЄТЬСЯ В МОМЕНТ РОЗКРИТТЯ (рішення власника, с28).
 * Жива перевірка с28 показала: коли знімок перечитувався на кожному
 * оновленні пулу, позначка, що НАРОДИЛАСЬ при вже розгорнутому блоці,
 * гасилась сама через ~2 с — скасування запису (critical!) зникало, не
 * показавшись нікому. Тепер гасяться ЛИШЕ id, які були в пулі, коли блок
 * розкрили (сценарій 1 ТЗ). Зміна, що прилетіла при відкритому блоці,
 * лишається непрочитаною до НАСТУПНОГО розкриття (або до зміни
 * `refreezeKey` — див. нижче).
 *
 * `refreezeKey` — для поверхонь, які «розгорнуті» постійно (простої на
 * дошці): передай відбиток УСПІШНО завантажених даних поверхні, і
 * перезаморозка стається саме тоді, коли користувачу реально показали
 * свіжий стан. Без цього постійно видима поверхня гасила б лише те, що
 * було на маунті, — нові позначки висіли б до перезавантаження сторінки.
 *
 * ⚠️ Ефект перевзводиться на невдалий ack (р2, L-10new: ackFailGen) —
 * ретрай іде по тих САМИХ заморожених id. Циклу немає: успішний ack
 * прибирає id з пулу → фільтр «ще непрочитані» дає порожньо → ранній вихід.
 * ⚠️ Але при СТІЙКІЙ помилці успіху не буде ніколи, тому перевзвід відкладений
 * (ACK_RETRY_MS, пакет №4 с29): ackFailGen росте не в момент невдачі, а по
 * таймеру — один на весь модуль, зі стелею 60 с. Без цього 401 давав
 * безперервний потік запитів від КОЖНОГО видимого хука.
 */
export function useAckWhenVisible(scope: AckScope | null, visible: boolean, refreezeKey?: string): void {
  const { status } = useUnreadChanges();
  const snap = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const key = scope
    ? scope.kind === "surface"
      ? `s:${scope.surface}`
      : scope.kind === "entity"
        ? `e:${scope.entityType}:${scope.entityId}`
        : `f:${scope.entityType}:${scope.entityId}:${scope.scope}`
    : "";

  // Відбиток живого пулу: потрібен, щоб ефект прокинувся, коли ack ЧАСТКОВО
  // пройшов або коли заморожені id нарешті зникли з пулу (ранній вихід).
  const fp = scope && visible
    ? ackIdsForScope(snap.index, scope, snap.snapshotIds).sort().join(",")
    : "";

  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  /* Заморожений знімок розкриття: { ключ scope, refreezeKey, userId, ids }.
     Живе в ref — його НЕ можна класти в стан: перезаморозка від ререндеру
     зробила б freeze беззмістовним. userId у записі — щоб релогін у тій
     самій вкладці при живому маунті не лишав постійно видиму поверхню зі
     заморозкою чужої сесії (ревʼю с28-р1, L-1). */
  const frozenRef = useRef<{ key: string; refreeze: string; uid: string | null; ids: string[] } | null>(null);

  useEffect(() => {
    // Згортання/зникнення scope → скинути заморозку: наступне розкриття
    // зафіксує НОВИЙ знімок (і тим самим підтвердить те, що прилетіло).
    if (!visible || !scopeRef.current) { frozenRef.current = null; return; }
    // 'ready' обовʼязкове: підтверджувати прочитання поверх помилки
    // завантаження означало б погасити крапку, не показавши зміну. Заморозку
    // при цьому НЕ чіпаємо і не створюємо: розкриття під час loading
    // зафіксує знімок першим успішним завантаженням.
    if (status !== "ready") return;

    const rk = refreezeKey ?? "";
    let fr = frozenRef.current;
    if (fr === null || fr.key !== key || fr.refreeze !== rk || fr.uid !== state.userId) {
      fr = {
        key,
        refreeze: rk,
        uid: state.userId,
        ids: ackIdsForScope(state.index, scopeRef.current, state.snapshotIds),
      };
      frozenRef.current = fr;
    }

    // Гасимо ЛИШЕ заморожені id, і лише ті з них, що ще непрочитані —
    // повторний виклик RPC з уже погашеними id не потрібен.
    const stillUnread = new Set(state.index.all.map((m) => m.id));
    const ids = fr.ids.filter((id) => stillUnread.has(id));
    if (!ids.length) return;
    void ackMarkerIds(ids);
    // scope навмисно через ref: це новий обʼєкт на кожен рендер. Реальні
    // тригери — key, видимість, статус, відбиток пулу, refreezeKey і
    // лічильник невдач ack.
  }, [key, visible, status, fp, refreezeKey, snap.ackFailGen]);
}
