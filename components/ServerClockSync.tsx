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
  observeWallStep,
  markClockStale,
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

/** Крок ВАРТОВОГО сирого годинника (F6, с55). Помітити переведення годинника
    треба ШВИДШЕ, ніж за `RESYNC_MS`, інакше дошка до десяти хвилин показує чужу
    добу, а звук читає стрибок як перевищення.
    ⚠️ Величина взята від НАЙШВИДШОГО споживача знімків, а не «того самого
    порядку, що тік дощок» — так стояла перша редакція, і ревʼю показало, що вона
    міряна не тим сусідом: базова лінія звуків тікає раз на 10 с
    (`OVERRUN_TICK_MS` у `lib/useQueueSounds.ts`), тобто вдвічі частіше за доску.
    ⚠️ І навіть так дірка ЗВУЖЕНА, а не закрита: тік звуку, що припав одразу
    після кроку годинника, устигне перший. Це названо в шапці `observeWallStep`.
    Сам тік коштує двох зчитувань годинника і жодного запиту в мережу; у
    прихованій вкладці браузер пригальмовує таймер, але це нешкідливо — обидва
    відліки знімаються в один момент, тож розбіжність не вигадується, а
    повернення на вкладку і так міряє зсув через `visibilitychange`. */
const WATCH_MS = 10 * 1000;

/** Нижня межа між пробами, які замовив ВАРТОВИЙ (знахідка ревʼю А).
    `inFlight` захищає лише від НАКЛАДАННЯ заходів, а не від їх частоти. На
    машині, де ОС править годинник щохвилини (віртуалка з гостьовою
    синхронізацією, здохла батарейка CMOS), вартовий без цієї межі замовляв би
    захід на кожному тіку — до кількох сотень RPC на годину на вкладку, вічно.
    Хвилина обрана як «частіше все одно не допоможе»: годинник, який система
    править частіше, зайвий замір не виправить. Планові заходи
    (`RESYNC_MS`, `visibilitychange`) ця межа НЕ обмежує. */
const WATCH_MIN_GAP_MS = 60 * 1000;

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
    /* F6 (с55): між заходами сирий годинник ПК могли перевести — тоді
       `serverNow()` їде, а `_offsetMs` ні, і ЖОДЕН споживач `clockEpoch()`
       цього не бачить (виміряно, позиція P14 зонда). Вартовий сам нічого не
       вирішує і епоху не крутить — чому саме так, розписано в шапці
       `observeWallStep`. Помітив розбіжність — просимо свіжу пробу, і далі все
       йде звичайним шляхом: `applyClockEstimate` вирішить, чи зсув змінився. */
    let lastWatchSync = Number.NEGATIVE_INFINITY;
    const w = setInterval(() => {
      if (!observeWallStep(Date.now(), performance.now())) return;
      const mono = performance.now();
      if (mono - lastWatchSync < WATCH_MIN_GAP_MS) return;
      lastWatchSync = mono;
      /* ⚠️ ПОРЯДОК ВАЖЛИВИЙ: спершу протухлення, потім проба. Без цього виклику
         `applyClockEstimate` відкине свіжу пробу, якщо чинна оцінка ще молодша
         за `CLOCK_STALE_MS`, а нова прийшла з гіршим RTT — і вартовий не змінив
         би НІЧОГО саме в найтиповішому випадку (корекція NTP на десятки
         секунд). Розбір — у шапці `markClockStale`. */
      markClockStale();
      void sync();
    }, WATCH_MS);
    /* Повернення на вкладку — саме той момент, коли годинник міг стрибнути
       (ноутбук вийшов зі сну, ОС підтягнула NTP). */
    const onVis = () => { if (document.visibilityState === "visible") void sync(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      clearInterval(t);
      clearInterval(w);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  return null;
}
