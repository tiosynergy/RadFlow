"use client";

/* ===== RadFlow — хук звукових сповіщень поверх snapshot'ів дошки =====
   useRealtimeRefetch не передає payload — він смикає лоадер, і дошка кладе
   свіжий стан у useState. Тому події визначаємо порівнянням послідовних
   УСПІШНИХ snapshot'ів (стан дошки вже включає оптимістичні оновлення, тож
   власна дія оператора і наступний realtime-refetch дають ОДИН перехід).

   Гарантії (див. також lib/soundEvents.ts, де живе чиста логіка):
     • перший успішний snapshot — baseline без звуку;
     • зміна scope записів (клініка/дата/роль) → baseline скидається БЕЗ звуку,
       і новий baseline сіється лише СВІЖИМ snapshot'ом (та сама identity
       масиву, що була до зміни scope, ігнорується — інакше при поверненні на
       попередню дату baseline виявився б «до-переключним» і дав хибний звук);
     • інциденти живуть ПОЗА денним scope (поломка не зникає від зміни дати) —
       їхній baseline скидається лише за incidentScopeKey (клініка/кабінети);
     • помилка завантаження (entries/incidents === null) baseline НЕ чистить;
     • polling / focus / reconnect з тим самим станом → без переходів → тиша;
     • burst-вікно ~360–500 мс: кілька подій → один звук, critical > ready;
     • прихована вкладка: події споживаються без звуку; ПЕРШИЙ дифф кожної
       лінії (записи/інциденти) після повернення на вкладку — тиха
       синхронізація baseline (заморожена вкладка нічого не дифала, і
       «накопичена історія» інакше пролізла б у перший же дифф); наступні
       диффи — свіжі події — звучать нормально;
     • одна подія → один звук на весь браузер (TabSoundDedupe, BroadcastChannel);
     • planned-інцидент, що дійшов до started_at, ловиться періодичною
       перевіркою (WALL-час клініки через wallNow), а не лише realtime-подією;
     • якщо настройка «увімкнено» пережила перезавантаження сторінки, аудіо
       розблоковується першим же жестом користувача (armAutoUnlock) — інакше
       AudioContext лишався б suspended і всі сигнали мовчали б;
     • будь-який збій звуку ковтається — черга працює як працювала. */

import { useCallback, useEffect, useRef, useState } from "react";
import { wallNow } from "./incidents";
import { clockEpoch, serverNow } from "./serverClock";
import {
  dedupeHash,
  diffIncidents,
  diffOverruns,
  diffQueueEntries,
  resolveBurst,
  settleEvents,
  type SoundEvent,
  type SoundIncident,
  type SoundQueueEntry,
} from "./soundEvents";
import { armAutoUnlock, playCriticalAttention, playPatientReady, playStudyOverrun } from "./soundEngine";
import { soundEnabled, subscribeSoundPref } from "./soundPrefs";
import { TabSoundDedupe } from "./soundTabDedupe";

type Options = {
  /** Ключ області порівняння ЗАПИСІВ: клініка + день (+роль). Зміна → скидання baseline. */
  scopeKey: string;
  /** Роль може отримувати звуки (false — напр. CEO/невідома роль: хук неактивний). */
  active?: boolean;
  /** Останній snapshot записів; null = завантаження/помилка → baseline не чіпаємо. */
  entries: SoundQueueEntry[] | null;
  /** «Пацієнт готовий» дозволено лише коли дошка відкрита на СЬОГОДНІ за TZ клініки. */
  readyEnabled?: boolean;
  /** Статуси critical-переходу; за замовчуванням лише needs_reschedule (персонал). */
  criticalStatuses?: readonly string[];
  /** Активні/planned інциденти клініки; null = не стежимо / ще не завантажено / помилка. */
  incidents?: SoundIncident[] | null;
  /** Звузити інциденти до кабінетів (радіолог — лише призначені йому). */
  incidentRoomIds?: readonly string[] | null;
  /** Озвучувати перевищення планового часу дослідження (таймер став червоним).
   *  Лише для СЬОГОДНІШНЬОЇ дошки: в інші дні in_progress не буває. Направнику
   *  не передається — перевищення не його зона відповідальності. */
  overrunEnabled?: boolean;
  /** Ключ області ІНЦИДЕНТІВ (клініка + набір кабінетів, БЕЗ дати). Зміна →
   *  тихий re-baseline: інцидент, що «увійшов у scope» (радіологу видали новий
   *  кабінет із давнім простоєм), не видається за щойно активований. */
  incidentScopeKey?: string;
};

const BURST_MS = 360;           // вікно агрегації сплеску подій
const BURST_JITTER_MS = 140;    // випадковий зсув (разом ≤ 500 мс), щоб вкладки не флашили одночасно
const INCIDENT_TICK_MS = 15000; // період перевірки «planned дійшов до started_at»
const OVERRUN_TICK_MS = 10000;  // період перевірки «дослідження вийшло за план»
const HIDDEN_GRACE_MS = 3000;   // коротше приховування вкладки історію не накопичує

export function useQueueSounds({
  scopeKey,
  active = true,
  entries,
  readyEnabled = true,
  criticalStatuses,
  incidents = null,
  incidentRoomIds = null,
  incidentScopeKey = "",
  overrunEnabled = false,
}: Options): void {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    setEnabled(soundEnabled());
    return subscribeSoundPref(setEnabled);
  }, []);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  // Настройка «on» пережила перезавантаження → AudioContext ще suspended, а
  // клік по перемикачу ніхто не повторить. Озброюємо разове розблокування
  // першим-ліпшим жестом користувача (click/keydown будь-де на сторінці).
  useEffect(() => {
    if (enabled) armAutoUnlock();
  }, [enabled]);

  const prevEntriesRef = useRef<Map<string, string> | null>(null);
  const lastEntriesIdentityRef = useRef<SoundQueueEntry[] | null>(null);
  const scopeFreshRef = useRef(true);
  const knownIncRef = useRef<Map<string, boolean> | null>(null);
  const lastIncidentsRef = useRef<SoundIncident[] | null>(null);
  /* Перевищення живе на тих самих записах, але подія народжується ПЛИНОМ ЧАСУ,
     без жодної зміни в БД — тому окремий baseline і власний тік, як в інцидентів. */
  const knownOverRef = useRef<Map<string, boolean> | null>(null);
  const lastEntriesArrRef = useRef<SoundQueueEntry[] | null>(null);
  const overrunSilentOnceRef = useRef(false);
  /* Той самий гейт, що й у лінії записів (ревʼю M2): у момент перемикання дати
     проп ще тримає масив ПОПЕРЕДНЬОГО дня (дошки не вмикають loading на зміну
     dayKey), і без цієї перевірки baseline перевищень засівався б чужим днем. */
  const overrunScopeFreshRef = useRef(true);
  const lastOverrunIdentityRef = useRef<SoundQueueEntry[] | null>(null);
  /* fired — «спожиті» ключі подій: гарантія «впервые» (повтор того самого факту
     не звучить) і тиша для історії, накопиченої при вимкненому звуку/прихованій
     вкладці. Живе на весь маунт дошки; назовні (BroadcastChannel) ідуть лише хеші. */
  const firedRef = useRef<Set<string>>(new Set());
  const pendingRef = useRef<SoundEvent[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dedupeRef = useRef<TabSoundDedupe | null>(null);
  const hiddenAtRef = useRef<number>(0);
  /* «Тихий перший дифф після повернення на вкладку» — окремо для записів та
     інцидентів. Заморожена вкладка не дифала взагалі, тож перший дифф після
     повернення порівнює стан «до сну» зі станом «після» — це і є накопичена
     історія, її синхронізуємо БЕЗ звуку. Наступні диффи (свіжі події через
     секунди після повернення, напр. реальна поломка) звучать нормально. */
  const entriesSilentOnceRef = useRef(false);
  const incidentsSilentOnceRef = useRef(false);

  /* ⚠️ Ф4-8, знахідка ревʼю (A/MEDIUM-3, Б/M2). Поправка на зсув годинника
     приземляється АСИНХРОННО — після `getSession` і трьох RPC, тобто майже
     завжди ПІЗНІШЕ за перший snapshot дошки, який їде одним запитом. Отже
     baseline знімався на СЛАМАНОМУ годиннику, а найближчий тік рахувався вже
     на виправленому — і перехід false → true, породжений стрибком на 8 хвилин,
     дифер читав як справжнє перевищення. Наслідок: звук на дослідження, яке
     було простроченим ще до відкриття дошки, — рівно те, що забороняє
     інваріант «перший прогін тихий» (lib/soundEvents.ts).
     `has`-гард від цього не рятує: id не новий, поїхав годинник.
     Тому стрибок годинника трактуємо як повернення на вкладку — тихий
     ре-baseline. Механізм той самий, що вже перевірений на visibilitychange;
     нового способу гасити звук не заводимо.
     Лічильники окремі для кожної лінії: одна не сміє «зʼїсти» подію в іншої. */
  const incClockEpochRef = useRef(clockEpoch());
  const overClockEpochRef = useRef(clockEpoch());

  useEffect(() => {
    const d = new TabSoundDedupe();
    dedupeRef.current = d;
    const onVis = () => {
      if (document.visibilityState !== "visible") { hiddenAtRef.current = Date.now(); return; }
      /* Тиха синхронізація потрібна лише коли вкладка була прихована ДОСТАТНЬО
         довго, щоб щось накопичилось. Інакше швидке перемикання вкладок туди-сюди
         тримало б прапорець вічно взведеним, і жодне перевищення не прозвучало б
         (ревʼю L9): у лінії перевищень прапорець гасить тік раз на 10 с, а не
         найближчий snapshot. */
      const hiddenMs = Date.now() - hiddenAtRef.current;
      if (hiddenMs < HIDDEN_GRACE_MS) return;
      entriesSilentOnceRef.current = true;
      incidentsSilentOnceRef.current = true;
      overrunSilentOnceRef.current = true;
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      d.close();
      dedupeRef.current = null;
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
    };
  }, []);

  /* Зміна scope ЗАПИСІВ (клініка/дата/роль) → скид baseline без звуку. fired НЕ
     чистимо: ключі привʼязані до конкретних фактів (id+статус), і повернення на
     попередню дату не має пере-озвучити старі події. Інциденти тут НЕ чіпаємо —
     їхнє життя не залежить від обраного дня (див. incidentScopeKey нижче). */
  useEffect(() => {
    prevEntriesRef.current = null;
    scopeFreshRef.current = true;
    // Перевищення прив'язане до дня дошки так само, як записи.
    knownOverRef.current = null;
    lastEntriesArrRef.current = null;
    overrunScopeFreshRef.current = true;
  }, [scopeKey]);

  /* Зміна scope ІНЦИДЕНТІВ (клініка / набір кабінетів) → тихий re-baseline.
     Скидаємо І список: після зміни клініки без remount lastIncidentsRef інакше
     тримав би інциденти ЧУЖОЇ клініки, і interval пересіяв би ними baseline.
     Для радіолога (змінився лише набір кабінетів) ефект інцидентів нижче
     ре-ранається в цьому ж коміті (deps incidentRoomIds) і одразу відновлює
     список із того самого валідного пропа. */
  useEffect(() => {
    knownIncRef.current = null;
    lastIncidentsRef.current = null;
  }, [incidentScopeKey]);

  const queueEvents = useCallback(
    (events: SoundEvent[], silentSync = false) => {
      if (!events.length) return;
      const visible = typeof document !== "undefined" && document.visibilityState === "visible";
      // settleEvents СПОЖИВАЄ події (позначає fired) навіть коли звуку не буде:
      // вимкнено/приховано/тиха синхронізація → факт відомий, але мовчимо і
      // потім не повторюємо.
      const fresh = settleEvents(events, firedRef.current, {
        enabled: active && enabledRef.current && !silentSync,
        visible,
      });
      if (!fresh.length) return;
      pendingRef.current.push(...fresh);
      if (flushTimerRef.current) return; // вікно вже відкрите — доллємо в нього
      flushTimerRef.current = setTimeout(() => {
        flushTimerRef.current = null;
        const batch = pendingRef.current;
        pendingRef.current = [];
        // Стан міг змінитись, поки йшло вікно агрегації.
        if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
        if (!enabledRef.current) return;
        const kind = resolveBurst(batch);
        if (!kind) return;
        const keys = batch.map((e) => dedupeHash(e.key));
        const dedupe = dedupeRef.current;
        /* Арбітраж права зіграти — асинхронний (Web Locks). Чекаємо лише МИТЬ
           видачі локу, тож затримка — мілісекунди; AudioContext уже розблоковано
           жестом, і пауза йому не шкодить. */
        void (async () => {
          const mine = dedupe ? await dedupe.claimAsync(keys) : [...keys];
          if (!mine.length) return; // ключі дісталися іншій вкладці — вона й грає
          /* Поки тривав арбітраж, стан міг змінитись: вкладку сховали, звук
             вимкнули, дошку розмонтували. Перевіряємо ЗНОВУ — інакше сюди
             повертається той самий клас дефекту, що й «протухле замикання». */
          if (!enabledRef.current) return;
          if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
          if (dedupeRef.current !== dedupe) return;
          try {
            if (kind === "critical") playCriticalAttention();
            else if (kind === "overrun") playStudyOverrun();
            else playPatientReady();
          } catch {
            /* звук не має права зламати дошку */
          }
        })();
      }, BURST_MS + Math.floor(Math.random() * BURST_JITTER_MS));
    },
    [active]
  );

  /* Записи черги: дифаємо кожен успішний snapshot. Ідентичний повторний стан
     (polling/focus/reconnect) переходів не дає — тиша безкоштовно. Після зміни
     scope чекаємо СВІЖИЙ snapshot (нову identity масиву): у момент перемикання
     дати проп ще тримає записи попереднього дня, і сіяти ними новий baseline
     не можна — повернення на цю дату дифалось би проти «до-переключного» стану. */
  useEffect(() => {
    if (!active) return;
    if (!entries) return; // помилка/завантаження — baseline лишається як був
    if (scopeFreshRef.current) {
      if (lastEntriesIdentityRef.current === entries) return; // старий snapshot чужого scope
      scopeFreshRef.current = false;
    }
    lastEntriesIdentityRef.current = entries;
    // Перший дифф після повернення видимості — тиха синхронізація baseline.
    const silentSync = entriesSilentOnceRef.current;
    entriesSilentOnceRef.current = false;
    const { events, next } = diffQueueEntries(prevEntriesRef.current, entries, {
      readyEnabled,
      criticalStatuses,
    });
    prevEntriesRef.current = next;
    queueEvents(events, silentSync);
    // criticalStatuses передавайте стабільною константою модуля (не інлайн-літералом).
  }, [active, entries, readyEnabled, criticalStatuses, queueEvents]);

  /* Інциденти: перераховуємо на кожен успішний snapshot І періодично — planned
     стає активним самим плином часу, без жодної події в БД. Між refetch'ами
     тикаємо по останньому успішному списку; помилка завантаження (null) ні
     список, ні baseline не затирає. ВАЖЛИВО: дошка має передавати null, поки
     перший loadIncidents не завершився успішно, — інакше стартовий [] став би
     baseline'ом, і давно активний простій «зазвучав» би на маунті. */
  useEffect(() => {
    if (!active) return;
    if (incidents) lastIncidentsRef.current = incidents;
    const evalIncidents = () => {
      const list = lastIncidentsRef.current;
      if (!list) return;
      // Перший дифф після повернення видимості — тиха синхронізація baseline.
      // Стрибок годинника (Ф4-8) трактуємо так само: baseline знято іншим
      // годинником, тож різниця з «зараз» — не плин часу.
      const epochNow = clockEpoch();
      const clockJumped = epochNow !== incClockEpochRef.current;
      incClockEpochRef.current = epochNow;
      const silentSync = incidentsSilentOnceRef.current || clockJumped;
      incidentsSilentOnceRef.current = false;
      const { events, next } = diffIncidents(knownIncRef.current, list, wallNow(), incidentRoomIds);
      knownIncRef.current = next;
      queueEvents(events, silentSync);
    };
    evalIncidents();
    if (!lastIncidentsRef.current) return;
    const t = setInterval(evalIncidents, INCIDENT_TICK_MS);
    return () => clearInterval(t);
  }, [active, incidents, incidentRoomIds, queueEvents]);

  /* Перевищення планового часу: подія настає САМА, без події в БД, тож окрім
     звірки на кожен успішний snapshot тікаємо таймером. Помилка завантаження
     (entries === null) список не затирає — рахуємо по останньому успішному. */
  useEffect(() => {
    if (!active || !overrunEnabled) return;
    /* Чекаємо СВІЖИЙ знімок поточного scope (див. overrunScopeFreshRef). */
    if (overrunScopeFreshRef.current) {
      if (lastOverrunIdentityRef.current === entries) return;
      overrunScopeFreshRef.current = false;
    }
    lastOverrunIdentityRef.current = entries;
    /* Помилка завантаження (entries === null): baseline лишаємо, але НЕ тікаємо.
       Подія тут народжується самим ходом годинника, тож тік по застарілому
       списку озвучив би перевищення для вже завершеного дослідження (ревʼю L10).
       Дані повернулись → ефект перезапуститься і тік відновиться. */
    if (!entries) return;
    lastEntriesArrRef.current = entries;
    const evalOverruns = () => {
      const list = lastEntriesArrRef.current;
      if (!list) return;
      const epochNow = clockEpoch();
      const clockJumped = epochNow !== overClockEpochRef.current;
      overClockEpochRef.current = epochNow;
      const silentSync = overrunSilentOnceRef.current || clockJumped;
      overrunSilentOnceRef.current = false;
      /* Ф4-8: годинник БАЗИ — поріг перевищення рахується від in_progress_at,
         який ставить база. З годинником ПК, що поспішає, звук лунав за стільки
         ж хвилин ДО реального кінця вікна; зі зворотним зсувом — не лунав
         ніколи. */
      const { events, next } = diffOverruns(knownOverRef.current, list, serverNow());
      knownOverRef.current = next;
      queueEvents(events, silentSync);
    };
    evalOverruns();
    const t = setInterval(evalOverruns, OVERRUN_TICK_MS);
    return () => clearInterval(t);
  }, [active, overrunEnabled, entries, scopeKey, queueEvents]);
}
