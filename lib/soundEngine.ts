"use client";

/* ===== RadFlow — Web Audio движок звукових сповіщень =====
   ТРИ семантичні звуки на весь продукт (кожен доданий окремим рішенням власника,
   не розширювати без доведеної операційної потреби):
     • playPatientReady()      — спокійний ВИСХІДНИЙ подвійний сигнал (~330 мс);
     • playCriticalAttention() — виразний тричастинний (~700 мс), спільний для
                                 breakdown / maintenance / emergency / needs_reschedule;
     • playStudyOverrun()      — тихий КОРОТКИЙ низхідний тричастинний (~370 мс):
                                 дослідження триває довше запланованого.
   Тони генеруються програмно (осцилятор + огинаюча) — без зовнішніх аудіофайлів
   і бібліотек. Без різких високих частот; м'яка атака/затухання, щоб не клацало.

   Компоненти дошок НЕ знають частот і тривалостей — лише семантичні команди.
   Будь-яка помилка аудіо ковтається: звук не має права зламати чергу.

   Autoplay-політика браузера: AudioContext стартує лише з жесту користувача.
   unlockAudio() викликається З КЛІКУ по перемикачу; якщо контекст так і не
   перейшов у running — повертає false, і UI не показує хибне «увімкнено». */

type WindowWithWebkit = Window & { webkitAudioContext?: typeof AudioContext };

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (ctx) return ctx;
  try {
    const AC = window.AudioContext || (window as WindowWithWebkit).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  } catch {
    ctx = null; // Web Audio недоступний — застосунок працює далі без звуку
  }
  return ctx;
}

/** Розблокувати аудіо в межах жесту користувача. true = контекст реально запущено. */
export async function unlockAudio(): Promise<boolean> {
  const c = getCtx();
  if (!c) return false;
  try {
    if (c.state !== "running") await c.resume();
    return c.state === "running";
  } catch {
    return false;
  }
}

/* Настройка «увімкнено» переживає перезавантаження сторінки, а розблокований
   AudioContext — НІ: без цього хука всі сигнали після F5 мовчали б, поки
   користувач не клацне перемикач ще раз. Озброюємо спробу розблокування на
   перший-ліпший жест користувача; після успіху слухачі знімаються.
   Набір подій ширший за pointerdown свідомо: на touch-пристроях (iPad у
   кабінеті) user activation дають pointerup/touchend/keydown, а НЕ
   touch-pointerdown — з одним pointerdown Safari лишав би контекст suspended. */
const GESTURE_EVENTS = ["pointerdown", "pointerup", "touchend", "keydown"] as const;
let autoUnlockArmed = false;

export function armAutoUnlock(): void {
  if (typeof window === "undefined" || autoUnlockArmed) return;
  autoUnlockArmed = true;
  const onGesture = () => {
    unlockAudio()
      .then((ok) => {
        if (!ok) return; // жест був, але не допоміг — спробуємо на наступному
        for (const ev of GESTURE_EVENTS) window.removeEventListener(ev, onGesture, true);
      })
      .catch(() => {});
  };
  for (const ev of GESTURE_EVENTS) window.addEventListener(ev, onGesture, true);
}

/* Браузер міг сам суспендити контекст уже ПІСЛЯ розблокування (iOS: дзвінок,
   перемикання аудіосесії). Виявили при спробі грати → переозброюємо
   розблокування наступним жестом. */
function rearmAutoUnlock(): void {
  autoUnlockArmed = false;
  armAutoUnlock();
}

function tone(c: AudioContext, at: number, freq: number, durMs: number, peak: number, type: OscillatorType): void {
  const osc = c.createOscillator();
  const g = c.createGain();
  const dur = durMs / 1000;
  osc.type = type;
  osc.frequency.value = freq;
  // М'яка атака (15 мс) і експоненційне затухання — без клацань на межах.
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(peak, at + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(g);
  g.connect(c.destination);
  osc.start(at);
  osc.stop(at + dur + 0.02);
}

function playNotes(notes: ReadonlyArray<readonly [offsetMs: number, freq: number, durMs: number, peak: number]>, type: OscillatorType): void {
  try {
    const c = getCtx();
    if (!c) return;
    if (c.state !== "running") {
      rearmAutoUnlock(); // заблоковано/суспендовано → тиша зараз, розблокуємось наступним жестом
      return;
    }
    const t0 = c.currentTime + 0.02;
    for (const [off, f, dur, peak] of notes) tone(c, t0 + off / 1000, f, dur, peak, type);
  } catch {
    /* помилки аудіо не впливають на роботу черги */
  }
}

/** «Пацієнт готовий до виклику»: спокійний подвійний сигнал, разом ~330 мс. */
export function playPatientReady(): void {
  playNotes([[0, 587.33, 140, 0.10], [170, 783.99, 160, 0.10]], "sine"); // D5 → G5
}

/** «Критичне втручання»: виразний тричастинний сигнал, разом ~680 мс. */
export function playCriticalAttention(): void {
  playNotes([[0, 659.25, 160, 0.16], [230, 493.88, 160, 0.16], [460, 659.25, 200, 0.16]], "triangle"); // E5–B4–E5
}

/** «Дослідження триває довше запланованого»: КОРОТКИЙ ТРИЧАСТИННИЙ низхідний
    сигнал ~370 мс (рішення власника).
    Від критичного відрізняється трьома речами одразу, щоб не сплутати «пора
    завершувати» з «апарат зламався»: удвічі тихіший (0.085 проти 0.16), удвічі
    коротший (~370 проти ~680 мс) і рівно НИЗХІДНИЙ, тоді як критичний іде
    вгору-вниз-угору (E5–B4–E5).
    Від playPatientReady — тембром (triangle проти sine), напрямком (той
    висхідний) і кількістю нот. */
export function playStudyOverrun(): void {
  playNotes(
    [[0, 783.99, 110, 0.085], [130, 659.25, 110, 0.085], [260, 523.25, 130, 0.085]],
    "triangle"
  ); // G5 → E5 → C5
}
