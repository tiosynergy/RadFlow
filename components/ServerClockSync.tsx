"use client";

/* ===== RadFlow — вимірювач зсуву годинника (Ф4-8) =====

   Єдине місце в застосунку, яке ходить у мережу за часом БАЗИ і віддає проби
   в `lib/serverClock.ts`. Змонтовано ОДИН раз у кореневому layout — свідомо:
   якби синхронізацію робила кожна дошка «у себе», правило «коли пробі можна
   вірити» роз'їхалось би так само, як роз'їхались чотири копії округлення
   хвилин простою (Ф4-7).

   НІЧОГО НЕ МАЛЮЄ. Жодного стану, жодної розмітки — тільки ефект.

   ⚠️ Без сесії виклику НЕ робимо. `public.server_now()` має EXECUTE лише в
   `authenticated` (0169), тож анонімна сторінка отримала б 42501 на кожному
   завантаженні: шум у мережевому логу без жодної користі — анонімні екрани
   (login/register/set-password) клінічного часу не показують.

   ⚠️ Будь-який збій — тиша і зсув 0, тобто РІВНО поведінка до пакета. Тут
   немає «не знаємо → блокуємо»: таймер і звук не ухвалюють рішень про дані
   (їх ухвалює сервер), а гейт на невимiряний годинник гасив би дошку на
   кожному холодному старті. */

import { useEffect } from "react";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/client";
import {
  applyClockEstimate,
  offsetFromSamples,
  parseServerTime,
  type ClockSample,
} from "@/lib/serverClock";

/** Скільки проб береться за один захід. Три — компроміс: одна проба залежить
    від випадкового сплеску мережі, десяток означав би десяток запитів на
    кожне завантаження дошки. Беремо найкращу за RTT (див. offsetFromSamples). */
const SAMPLES = 3;

/** Перезамір раз на 10 хв: годинник ПК може «поїхати» і посеред зміни
    (корекція NTP, ручний перевід, вихід зі сну). */
const RESYNC_MS = 10 * 60 * 1000;

export default function ServerClockSync() {
  useEffect(() => {
    if (!isSupabaseConfigured()) return;
    let alive = true;
    /* Захід уже йде — другого не запускаємо (знахідка ревʼю Б, MEDIUM).
       Alt-tab між дошкою і PACS — робоча практика, і без цього прапорця кожне
       повернення на вкладку стартувало б ще три RPC поверх незавершених.
       Другий поверх захисту — в `applyClockEstimate`: гірша оцінка не заміняє
       кращу, тож навіть якщо заходи колись накладуться, переможе не той, хто
       фінішував останнім. */
    let inFlight = false;
    const supabase = createClient();

    async function sample(): Promise<ClockSample | null> {
      /* Пара «стінний + монотонний» знімається з обох боків запиту: тривалість
         рахується монотонним годинником, який не переводять, а розбіжність між
         відліками і викриває стрибок стінного посеред проби (див. шапку
         lib/serverClock.ts). */
      const t0 = Date.now();
      const mono0 = performance.now();
      const { data, error } = await supabase.rpc("server_now");
      const mono1 = performance.now();
      const t1 = Date.now();
      if (error || data == null) return null;
      const serverMs = parseServerTime(data);
      if (!Number.isFinite(serverMs)) return null;
      return { t0, serverMs, t1, mono0, mono1 };
    }

    async function sync() {
      if (inFlight) return;
      inFlight = true;
      try {
        /* Перевірка «є кому викликати RPC»: без сесії `server_now()` віддасть
           42501 (EXECUTE лише в authenticated, 0169).
           ⚠️ Це НЕ безкоштовно: у supabase-js v2 `getSession()` при протухлому
           access-токені йде в мережу за оновленням. Перша редакція коментаря
           стверджувала протилежне (знахідка ревʼю А і Б) — тож перший захід
           після довгої паузи може коштувати ще один раунд-тріп. */
        const { data: { session } } = await supabase.auth.getSession();
        if (!alive || !session) return;
        const samples: ClockSample[] = [];
        for (let i = 0; i < SAMPLES; i++) {
          const s = await sample();
          if (!alive) return;
          if (s) samples.push(s);
        }
        applyClockEstimate(offsetFromSamples(samples));
      } catch {
        /* Мережа, стара база без 0169, протухла сесія — зсув лишається 0.
           Мовчки: це не помилка користувача і не втрата даних. */
      } finally {
        inFlight = false;
      }
    }

    void sync();
    const t = setInterval(() => void sync(), RESYNC_MS);
    /* Повернення на вкладку — саме той момент, коли годинник міг стрибнути
       (ноутбук вийшов зі сну, ОС підтягнула NTP). */
    const onVis = () => { if (document.visibilityState === "visible") void sync(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  return null;
}
