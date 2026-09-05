"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
/* U-62: рішення хука винесені в чисті функції — їх можна запінити тестом.
   DOM-тестів у проєкті немає навмисно (шапка vitest.config.ts), тож інакше
   ці правила лишились би без сторожа взагалі. */
import {
  POLL_BASE_MS,
  nextPollDelay,
  shouldRefetchOnReturn,
  shouldResetBackoff,
} from "@/lib/realtimeRefetchPolicy";

export type RealtimeSub = {
  /** Таблица public.* для подписки на postgres_changes. */
  table: string;
  /** RLS-совместимый фильтр, напр. `clinic_id=eq.<id>`. */
  filter?: string;
  /** Что вызвать при изменении этой таблицы (точечный лоадер доски). */
  onChange: () => void;
  /* Ключ дебаунса. По умолчанию — уникальный на подписку, то есть у каждой свой
     таймер. Если несколько подписок ведут в ОДИН лоадер (CEO: по подписке на
     каждый центр, onChange у всех = reload), без общего ключа всплеск в 20 центрах
     давал до 20 полных reload'ов подряд. Задайте один и тот же debounceKey — и
     сработает один вызов. */
  debounceKey?: string;
  /* U-62/Д2 і Д5 (с57): НЕ кликати цей `onChange` у ПЕРВИННОМУ `callAll`.
     Решта викликів (подія, повернення у вкладку, поллінг, звірка після обриву,
     оновлення токена) працюють як раніше.

     ⚠️ Ставте лише там, де первинний виклик заміряно ХОЛОСТИМ:
       • `onChange` робить рівно `router.refresh()` — сторінку щойно віддав
         сервер, тож RSC-перезавантаження на маунті нічого не оновлює. Замір
         с57: на дошці черги таких підписок ТРИ і в кожної свій ключ, отже
         маунт давав до трьох зайвих RSC-перезавантажень;
       • компонент уже вантажить це сам у власному `useEffect`. Замір с57:
         `WaitlistBoard` на маунті робив `reload()`, `loadIncidents()` і
         `loadCounts()` ПО ДВА РАЗИ — свій ефект плюс первинний `callAll`.

     ⚠️ НЕ ставте, якщо первинний виклик — єдиний спосіб отримати дані: тоді
     екран лишиться порожнім до першої події або тику поллінга. Дефолт
     (`undefined`) поведінки не міняє. */
  skipInitial?: boolean;
};

type Options = {
  /** Уникальное имя канала; при смене (напр. clinicId) — переподписка. `null` отключает хук. */
  channelName: string | null;
  /** Подписки: на каждую таблицу — свой лоадер (не общий refetchAll). */
  subscriptions: RealtimeSub[];
  /** Дебаунс всплеска событий по одной таблице, мс. */
  debounceMs?: number;
  /* Аудит 2026-08-06 H-3B: РЕДКИЙ поллинг ПРИ ЖИВОМ сокете. Realtime-события
     ходят под RLS: направник НЕ получает изменения чужих записей, то есть при
     здоровом `SUBSCRIBED` его открытая сетка занятости не обновится никогда
     (это не fallback-сценарий, сокет исправен). Задайте интервал — и callAll
     будет дёргаться и при живой подписке; события realtime при этом работают
     как раньше (мгновенно для тех, кому RLS их доставляет). Не задан — прежнее
     поведение: при SUBSCRIBED запросов нет. */
  pollWhenSubscribedMs?: number;
};

/**
 * Стан realtime-каналу — рівно те, що дошка має право сказати користувачеві.
 *
 * Аудит 2026-08-07 (M-2): бейдж «⚡ Real-time» був ЗАХАРДКОДЖЕНИЙ зеленим і
 * світився однаково при живому сокеті й при CHANNEL_ERROR. Хук усередині все
 * знав (саме за цим статусом він вмикає аварійний полінг), але назовні нічого
 * не віддавав, тож оператор, у якого сокет упав, бачив «миттєві оновлення» —
 * а насправді дані приїжджали раз на 8–60 с. Найгірше це в дошці черги: людина
 * дивиться на екран і вважає, що бачить кабінети «зараз».
 *
 * `everLive` відрізняє ПЕРШЕ підключення («Підключення…», даних ще не було) від
 * ОБРИВУ («Звʼязок втрачено» — дані були і встигли застаріти). Без нього бейдж
 * на кожному маунті блимав би тривогою.
 */
export type RealtimeHealth = {
  /** Канал у статусі SUBSCRIBED прямо зараз. */
  live: boolean;
  /** У цьому каналі вже була хоч одна успішна підписка. */
  everLive: boolean;
  /**
   * Була хоч одна НЕВДАЛА спроба (CHANNEL_ERROR / TIMED_OUT / CLOSED).
   *
   * Потрібен окремо від `everLive` (ревʼю пакета M-2, р.1): якщо сокет не піднявся
   * ЖОДНОГО разу — Realtime лежить, ws різаний корпоративною мережею — то
   * `everLive` так і лишиться false, і бейдж вічно писав би «Підключення…»,
   * поки хук уже давно живе на аварійному полінгу 8→60 с. Тобто рівно той
   * сценарій, заради якого M-2 і робився, лишився б незакритим.
   */
  failed: boolean;
};

const HEALTH_INITIAL: RealtimeHealth = { live: false, everLive: false, failed: false };

/**
 * Единый realtime-паттерн для досок RadFlow.
 *
 * Зачем (TD-3): раньше каждая доска делала полный refetch на КАЖДОЕ событие
 * и держала безусловный `setInterval` каждые 10–15 с. На большом числе
 * кабинетов/клиентов это давало постоянную нагрузку на БД, не зависящую от
 * активности. Здесь:
 *   1. `setAuth(token)` ПЕРЕД подпиской — иначе RLS не доставляет postgres_changes.
 *   2. События дебаунсятся ПОТАБЛИЧНО: всплеск изменений → один вызов лоадера,
 *      и только релевантного (queue → reload, incidents → loadIncidents, ...).
 *   3. Поллинг включается ТОЛЬКО когда сокет не `SUBSCRIBED`, с экспоненциальным
 *      backoff; при простое и живом сокете запросов к БД нет.
 *   4. Подстраховка обновлением при возврате на вкладку / фокусе сохранена.
 *
 * Следующий шаг (вне этого хука): инкрементальный merge по `payload.new/old`
 * вместо вызова лоадера — убирает и сам refetch. Требует тестов на каждой доске.
 */
export function useRealtimeRefetch({
  channelName,
  subscriptions,
  debounceMs = 250,
  pollWhenSubscribedMs,
}: Options): RealtimeHealth {
  /* Стан каналу для UI. Викликачі, яким бейдж не потрібен, просто ігнорують
     повернене значення — сигнатура сумісна з попередньою (`void`). */
  const [health, setHealth] = useState<RealtimeHealth>(HEALTH_INITIAL);
  // Подписки берём через ref, чтобы смена идентичности лоадеров (useCallback)
  // не вызывала переподписку — она зависит только от channelName.
  /* ⚠️ U-62/Д4, названо чесно замість обіцянки, якої код не дає. Присвоєння
     йде в ТІЛІ рендера, а перепідписка — в ефекті: між ними є вікно, у якому
     `subsRef.current` уже НОВИЙ, а серверні біндинги ще СТАРІ. Обробник бере
     `subsRef.current[i]` за індексом, тож у цьому вікні подія теоретично може
     потрапити в чужий лоадер. Сьогодні це НЕДОСЯЖНО: усі споживачі міняють
     склад підписок тільки разом із `subscriptionKey`, а він перестворює канал.
     Тому це не дефект, а МЕЖА — і вона тут написана, бо раніше на цьому місці
     стояла гарантія, якої немає. */
  const subsRef = useRef(subscriptions);
  subsRef.current = subscriptions;

  /* СТРУКТУРНЫЙ ключ подписок (техаудит 2026-07-27, Medium-2). Эффект ниже
     намеренно не зависит от массива subscriptions (его identity меняется каждый
     рендер), но раньше он не зависел и от СТРУКТУРЫ: смена table/filter/числа
     подписок без смены channelName оставляла серверную подписку старой, а
     обработчик по индексу мог попасть в чужой лоадер. Ключ — строка из
     table|filter в порядке массива: пока структура прежняя, он стабилен
     (переподписки нет), изменилась — канал пересоздаётся, и индексы обработчиков
     снова совпадают с серверными подписками по построению. */
  const subscriptionKey = subscriptions
    .map((s) => s.table + "|" + (s.filter ?? ""))
    .join(";");

  useEffect(() => {
    /* Новий канал (зміна clinicId/періоду) або вимкнений хук — попередній стан
       уже не про нього. Функціональний апдейт із bail-out: без нього кожен маунт
       давав би зайвий ререндер дошки. */
    setHealth((h) => (h.live || h.everLive || h.failed ? HEALTH_INITIAL : h));
    if (!channelName) return;

    const supabase = createClient();
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | undefined;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let authUnsub: (() => void) | undefined;
    /* Был ли обрыв с момента последнего SUBSCRIBED. Нужен, чтобы отличить
       ПЕРВУЮ подписку (данные только что загрузили) от ВОЗВРАТА после потери
       связи (данные устарели на длину обрыва). */
    let hadDisconnect = false;
    let pollDelay = POLL_BASE_MS;
    /* U-62/Д3: коли прийшов останній SUBSCRIBED. Потрібен, щоб відрізнити
       СТАБІЛЬНУ підписку від дребезгу сокета — див. shouldResetBackoff. */
    let subscribedAt: number | null = null;
    /* U-62/Д1: коли востаннє перезапитували через повернення у вкладку.
       Повернення приходить ДВОМА подіями, і без цього кожне давало два callAll. */
    let lastReturnAt: number | null = null;
    /* Джиттер ±25% на КАЖДЫЙ интервал (техаудит Medium-1): без него все клиенты,
       потерявшие realtime в один момент (рестарт Realtime, сетевой сбой), стартуют
       поллинг синхронно и бьют в Supabase одновременными полными reload'ами —
       и остаются синхронными на каждом следующем тике, потому что backoff у всех
       считается одинаково. Случайный множитель разводит их по времени. */
    const jittered = (ms: number) => Math.round(ms * (0.75 + Math.random() * 0.5));
    const debouncers = new Map<string, ReturnType<typeof setTimeout>>();

    /* callAll — первинне завантаження, повернення на вкладку/фокус і кожен тик
       поллінга. Дедуплікуємо за тим самим ключем, що й дебаунс: у CEO підписок
       стільки ж, скільки центрів, і всі ведуть в ОДИН reload — без цього на маунті
       й на кожному фокусі летіло по 20 повних перезавантажень дашборда. */
    /* ⚠️ U-62/Д2,Д5: `initial` — це ПЕРВИННЕ завантаження на маунті. Підписки
       з `skipInitial` у ньому пропускаються (див. коментар до прапорця), решта
       викликів `callAll` їх кличе як раніше. Пропуск стоїть ДО дедуплікації
       навмисно: інакше пропущена підписка «зʼїдала» б спільний ключ і глушила
       сусідку, яка на маунті потрібна. */
    const callAll = (opts?: { initial?: boolean }) => {
      const seen = new Set<string>();
      subsRef.current.forEach((s, i) => {
        if (opts?.initial && s.skipInitial) return;
        const key = s.debounceKey ?? s.table + ":" + i;
        if (seen.has(key)) return;
        seen.add(key);
        s.onChange();
      });
    };

    const scheduleDebounced = (key: string, fn: () => void) => {
      const prev = debouncers.get(key);
      if (prev) clearTimeout(prev);
      debouncers.set(
        key,
        setTimeout(() => {
          debouncers.delete(key);
          fn();
        }, debounceMs)
      );
    };

    /* ⚠️ U-62/Д3: тут БІЛЬШЕ НЕ СКИДАЄТЬСЯ `pollDelay`. Скид переїхав у гілку
       ОБРИВУ і став умовним (`shouldResetBackoff`): раніше кожен `SUBSCRIBED`
       повертав затримку до восьми секунд, тож при дребезгу сокета backoff не
       розганявся ніколи і клієнт бив повним `callAll` кожні 8 с — саме тоді,
       коли сервісу найгірше. */
    const stopPolling = () => {
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = undefined;
      }
    };

    const startPolling = () => {
      if (pollTimer) return; // уже идёт
      const tick = () => {
        if (cancelled) return; // страховка от тика, запланированного до cleanup
        callAll();
        pollDelay = nextPollDelay(pollDelay);
        pollTimer = setTimeout(tick, jittered(pollDelay));
      };
      pollTimer = setTimeout(tick, jittered(pollDelay));
    };

    /* Медленный тикер при живом сокете (H-3B) — отдельный от аварийного
       поллинга: тот стартует при обрыве и умирает на SUBSCRIBED, этот наоборот
       живёт ТОЛЬКО при SUBSCRIBED (иначе работали бы оба сразу). Джиттер тот
       же — не синхронизировать клиентов. */
    let slowTimer: ReturnType<typeof setTimeout> | undefined;
    const stopSlowPolling = () => {
      if (slowTimer) {
        clearTimeout(slowTimer);
        slowTimer = undefined;
      }
    };
    const startSlowPolling = () => {
      if (!pollWhenSubscribedMs || slowTimer) return;
      const tick = () => {
        if (cancelled) return;
        callAll();
        slowTimer = setTimeout(tick, jittered(pollWhenSubscribedMs));
      };
      slowTimer = setTimeout(tick, jittered(pollWhenSubscribedMs));
    };

    (async () => {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (session?.access_token) supabase.realtime.setAuth(session.access_token);
      } catch {
        /* нет сессии — поллинг подстрахует */
      }
      if (cancelled) return;

      callAll({ initial: true }); // первичная загрузка

      let ch = supabase.channel(channelName);
      // table/filter стабильны для данного channelName; onChange берём актуальный
      // из subsRef в момент события (хендлеры доски — useCallback и меняют
      // идентичность при смене периода/даты, переподписка при этом не нужна).
      subsRef.current.forEach((s, i) => {
        ch = ch.on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: s.table,
            ...(s.filter ? { filter: s.filter } : {}),
          },
          () => {
            const cur = subsRef.current[i];
            if (cur) scheduleDebounced(cur.debounceKey ?? cur.table + ":" + i, cur.onChange);
          }
        );
      });
      channel = ch.subscribe((status) => {
        /* Ревью с15 (High-1): removeChannel в cleanup сам вызывает этот callback
           со статусом CLOSED — УЖЕ ПОСЛЕ stopPolling(). Без гарда каждая отписка
           (закрытие модалки слотов, смена даты/канала, смена subscriptionKey)
           заводила бы осиротевший поллинг-цикл, который никто не остановит. */
        if (cancelled) return;
        /* Стан для бейджа знімаємо ТУТ і тільки тут: це єдине місце, де ми
           справді знаємо статус сокета (аудит 2026-08-07, M-2). */
        setHealth((h) =>
          status === "SUBSCRIBED"
            ? (h.live && h.everLive ? h : { live: true, everLive: true, failed: false })
            : (!h.live && h.failed ? h : { live: false, everLive: h.everLive, failed: true })
        );
        if (status === "SUBSCRIBED") {
          subscribedAt = Date.now();
          stopPolling();
          /* ⚠️ ВОЗВРАТ ПОСЛЕ ОБРЫВА — это ещё и дыра в данных, а не только
             восстановленный сокет. События, случившиеся ПОКА связи не было,
             никто не досылает: Realtime не хранит историю. Раньше здесь
             stopPolling() просто гасил аварийный поллинг, и первое после
             реконнекта обновление приходило только со следующим медленным
             тиком (или когда пользователь вернётся на вкладку) — до этого
             экран уверенно показывал устаревшие данные.
             Сверять надо СРАЗУ. На ПЕРВОМ SUBSCRIBED этого не делаем:
             начальный callAll() уже отработал выше, второй был бы холостым
             дублем на каждом маунте каждой доски. */
          if (hadDisconnect) {
            hadDisconnect = false;
            callAll();
          }
          startSlowPolling();   // H-3B: редкая подстраховка при живом сокете
        } else {
          hadDisconnect = true;
          /* U-62/Д3: backoff повертається до базового ЛИШЕ після стабільної
             підписки. Дребезг (SUBSCRIBED на пів секунди → CLOSED) накопичений
             backoff зберігає, тож частота поллінга падає замість того, щоб
             вічно стояти на восьми секундах. */
          if (shouldResetBackoff(subscribedAt, Date.now())) pollDelay = POLL_BASE_MS;
          subscribedAt = null;
          stopSlowPolling();
          startPolling();       // CHANNEL_ERROR / TIMED_OUT / CLOSED
        }
      });

      /* Обновление токена. Realtime ходит под RLS: после ротации access-токена
         сокет остаётся на СТАРОМ, и сервер постепенно перестаёт доставлять
         события — молча, без CHANNEL_ERROR. Поэтому переустанавливаем токен и
         сверяемся с БД (ТЗ «красных точек», раздел Realtime and reconciliation). */
      const { data: authSub } = supabase.auth.onAuthStateChange((event, session) => {
        if (cancelled) return;
        if (event !== "TOKEN_REFRESHED" && event !== "SIGNED_IN") return;
        if (session?.access_token) supabase.realtime.setAuth(session.access_token);
        callAll();
      });
      authUnsub = () => authSub.subscription.unsubscribe();
    })();

    /* ⚠️ U-62/Д1: повернення у вкладку приходить ДВОМА подіями —
       `visibilitychange` (visible) і `focus`, — і браузери шлють їх обидві.
       Досі на кожне повернення летіло ДВА повні `callAll`; на дошці черги це
       до шести `router.refresh()` замість трьох. Дедуплікуємо за часом:
       правило — чиста функція, і саме вона запінена. */
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (!shouldRefetchOnReturn(lastReturnAt, now)) return;
      lastReturnAt = now;
      callAll();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      stopPolling();
      stopSlowPolling();
      if (authUnsub) authUnsub();
      debouncers.forEach((t) => clearTimeout(t));
      if (channel) supabase.removeChannel(channel);
    };
    /* subscriptions (identity) намеренно вне зависимостей — через subsRef;
       subscriptionKey держит СТРУКТУРУ: смена table/filter/состава → переподписка. */
  }, [channelName, debounceMs, subscriptionKey, pollWhenSubscribedMs]);

  return health;
}
