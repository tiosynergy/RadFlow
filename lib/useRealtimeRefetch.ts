"use client";

import { useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase/client";

export type RealtimeSub = {
  /** Таблица public.* для подписки на postgres_changes. */
  table: string;
  /** RLS-совместимый фильтр, напр. `clinic_id=eq.<id>`. */
  filter?: string;
  /** Что вызвать при изменении этой таблицы (точечный лоадер доски). */
  onChange: () => void;
};

type Options = {
  /** Уникальное имя канала; при смене (напр. clinicId) — переподписка. `null` отключает хук. */
  channelName: string | null;
  /** Подписки: на каждую таблицу — свой лоадер (не общий refetchAll). */
  subscriptions: RealtimeSub[];
  /** Дебаунс всплеска событий по одной таблице, мс. */
  debounceMs?: number;
};

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
}: Options): void {
  // Подписки берём через ref, чтобы смена идентичности лоадеров (useCallback)
  // не вызывала переподписку — она зависит только от channelName.
  const subsRef = useRef(subscriptions);
  subsRef.current = subscriptions;

  useEffect(() => {
    if (!channelName) return;

    const supabase = createClient();
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | undefined;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let pollDelay = 8000;
    const POLL_MAX = 60000;
    const debouncers = new Map<string, ReturnType<typeof setTimeout>>();

    const callAll = () => subsRef.current.forEach((s) => s.onChange());

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

    const stopPolling = () => {
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = undefined;
      }
      pollDelay = 8000;
    };

    const startPolling = () => {
      if (pollTimer) return; // уже идёт
      const tick = () => {
        callAll();
        pollDelay = Math.min(Math.round(pollDelay * 1.5), POLL_MAX);
        pollTimer = setTimeout(tick, pollDelay);
      };
      pollTimer = setTimeout(tick, pollDelay);
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

      callAll(); // первичная загрузка

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
            if (cur) scheduleDebounced(cur.table + ":" + i, cur.onChange);
          }
        );
      });
      channel = ch.subscribe((status) => {
        if (status === "SUBSCRIBED") stopPolling();
        else startPolling(); // CHANNEL_ERROR / TIMED_OUT / CLOSED
      });
    })();

    const onVisible = () => {
      if (document.visibilityState === "visible") callAll();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      stopPolling();
      debouncers.forEach((t) => clearTimeout(t));
      if (channel) supabase.removeChannel(channel);
    };
    // subscriptions намеренно вне зависимостей — через subsRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelName, debounceMs]);
}
