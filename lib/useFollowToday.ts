"use client";

/* ===== RadFlow — дошка слідує за «сьогодні», коли годинник виправили (U-70) =====

   ЧОМУ ЦЕ ІСНУЄ. U-70 перевів настінний канон (`wallNow`) на ВИМІРЯНИЙ годинник
   бази. Зсув приїжджає асинхронно — вже після того, як дошка зафіксувала
   `selectedDate = wallToday0()` першим рендером. Якщо поправка перетинає північ
   клініки (ПК відстає на 8 хв, справжній час 00:04), `today` їде на наступну
   добу, `selectedDate` лишається — і дошка МОВЧКИ стає архівом: `isToday`
   хибний, «Викликати» заблоковано, звуки вимкнено, а записів нового дня в зрізі
   немає взагалі. У радіолога ще гучніше: `isPast` вмикає read-only, тобто всі
   дії зникають. Без цього правила правка `wallNow` була б регресією, а не
   покращенням.

   ОДИН ЕКЗЕМПЛЯР НА ДВІ ДОШКИ — свідомо. У цьому проєкті вже двічі розходились
   дві копії одного правила (гейт `safetyUnknown` у computeCallBlock, дзеркало
   вікна виклику), тож правило живе тут, а дошки лише приносять свій стан.

   ⚠️ ПИТАННЯ, НА ЯКЕ ВІДПОВІДАЄ ПРАВИЛО — «чи перенесла ПОПРАВКА добу?», а не
   «чи змінилась доба з минулого разу» (знахідка ревʼю А, HIGH). Перша редакція
   порівнювала ключ доби з тим, що лишився від попереднього запуску ефекту, тож
   справжня північ при відкритій дошці лишала по собі ПРОТУХЛИЙ ключ: наступна
   ж поправка — будь-яка, хоч на секунду і хоч через 10 хвилин — читала цю
   різницю як свою і смикала дату під руками оператора. Тобто правило не «не
   реагувало на північ», воно ВІДКЛАДАЛО реакцію на північ до найближчого
   перезаміру. Тепер обидві доби рахуються від ОДНОГО Й ТОГО САМОГО `Date.now()`
   різними зсувами — до поправки і після; різниця може бути тільки поправчина, і
   від таймінгу рендерів не залежить зовсім.

   ⚠️ НА СПРАВЖНЮ ПІВНІЧ ПРАВИЛО НЕ РЕАГУЄ, і це не недогляд. Дошка, відкрита о
   23:59, о 00:00 лишається на вчорашній добі — так було до пакета, і міняти цю
   поведінку U-70 не збирався: оператор може дописувати вчорашній день. Пакет
   закриває рівно те, що сам і створив, — стрибок «сьогодні» від ПОПРАВКИ. */

import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { clockOffsetMs } from "./serverClock";
import { wallDayKey, wallDayKeyAt, wallToday0 } from "./incidents";
import { dateKeyOf } from "./schedule";
import { useClockEpoch } from "./useClockEpoch";

export type FollowTodayOpts = {
  /** Зона клініки (та сама, що йде в wallToday0 на дошці). */
  clinicTz?: string;
  /** Дата з deep-link «Пошук» (YYYY-MM-DD) — обрана оператором ЯВНО. */
  pinnedKey?: string | null;
  /** Відкрита модалка / інша дія, під якою дату чіпати не можна. */
  busy?: boolean;
  setSelectedDate: Dispatch<SetStateAction<Date>>;
};

export function useFollowToday({ clinicTz, pinnedKey, busy, setSelectedDate }: FollowTodayOpts): void {
  const epoch = useClockEpoch();          // не читається в тілі — це БУДИЛЬНИК ефекту
  const prevOffsetRef = useRef(clockOffsetMs());
  /* Ключ доби, яку дошка вважала «сьогодні» на момент ПЕРШОЇ ще не застосованої
     поправки. null = переносити нічого. */
  const pendingKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const prevOffset = prevOffsetRef.current;
    const nowOffset = clockOffsetMs();
    prevOffsetRef.current = nowOffset;

    if (nowOffset !== prevOffset) {
      const before = wallDayKeyAt(Date.now() + prevOffset, clinicTz);  // доба за СТАРИМ годинником
      const after = wallDayKey(clinicTz);                              // доба за НОВИМ
      /* Тільки ПЕРША незастосована поправка задає ключ: інакше друга поправка
         поспіль (рідко, але буває при поверненні з фонової вкладки) затерла б
         ключ на проміжну добу, і `selectedDate`, що лишився на вихідній, не
         збігся б із ним НІКОЛИ — перенесення тихо не сталось би. */
      if (before !== after && pendingKeyRef.current === null) pendingKeyRef.current = before;
    }

    const pending = pendingKeyRef.current;
    /* ⚠️ ПІД ВІДКРИТОЮ МОДАЛКОЮ — ЧЕКАЄМО, а не пропускаємо (знахідка ревʼю А,
       MEDIUM). Це не косметика: `StudyEditModal` отримує `scheduledDate={dayKey}`,
       `ScheduleEditModal` — `date={selectedDate}`, і зміна дати посеред
       заповнення записала б редагування в ІНШУ добу. Перенесення не
       скасовується, а відкладається до закриття модалки — інакше ми міняли б
       одну тиху ваду на іншу. */
    if (pending === null || busy) return;
    pendingKeyRef.current = null;

    setSelectedDate((cur) => {
      const k = dateKeyOf(cur);
      // Не «сьогодні» дошки — свідомо обрана інша доба, не наша справа.
      if (k !== pending) return cur;
      /* Deep-link «Пошук» відкрив дошку саме на цій даті (ревʼю А, MEDIUM):
         оператор прийшов по конкретний запис, і забрати його з-під нього
         означає зламати єдину причину переходу. Щойно він піде з цієї дати
         сам — правило знову діє. */
      if (pinnedKey && k === pinnedKey) return cur;
      return wallToday0(clinicTz);
    });
  }, [epoch, busy, clinicTz, pinnedKey, setSelectedDate]);
}
