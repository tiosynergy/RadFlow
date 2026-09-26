/* ===== RadFlow — «потримати над ціллю» під час перетягування (с81) =====
   Автомат наведення для міні-календаря: тримаєш рядок над днем — відкривається
   карта дня; над стрілкою місяця — календар гортається (і гортається далі,
   поки курсор на стрілці). Винесено в чисту функцію з компонента, бо
   правильність тут — у ПОРЯДКУ подій, який різниться між рушіями (ревʼю с81
   р1, High), а компонентних тестів у проєкті немає:

     • Blink/WebKit: `dragenter` НОВОЇ цілі приходить РАНІШЕ за `dragleave`
       старої. Безумовне гасіння таймера в `dragleave` вбивало таймер, щойно
       заведений для нового дня, — карта відкривалась лише для першого дня, на
       який зайшли з «нічийного» місця;
     • Gecko: `dragleave` старої → `dragenter` нової;
     • вхід у ДОЧІРНІЙ елемент цілі (крапка позначки) дає `dragleave` на самій
       цілі з `relatedTarget` усередині — це не вихід.

   Правило: таймер має КЛЮЧ цілі; `leave(key)` гасить лише свій ключ; `over(key)`
   перезаводить лише коли ключ інший; після спрацювання ключ лишається, тож
   повторні `dragover` тієї самої цілі не відкривають карту вдруге — вихід і
   повернення заводять таймер заново. Ціль із `repeat` (стрілка) після
   спрацювання перезаводиться сама. */

export type HoverTarget = {
  /** Скільки тримати (мс). */
  ms: number;
  /** Що зробити, коли протримали. */
  fire: () => void;
  /** Після спрацювання завести знову (стрілки місяця). */
  repeat?: boolean;
};

export type HoverArmer = {
  /** `dragenter` цілі. */
  enter: (key: string, t: HoverTarget) => void;
  /** `dragover` цілі (перезаводить лише при зміні ключа). */
  over: (key: string, t: HoverTarget) => void;
  /** `dragleave` цілі. `inside` — курсор пішов у дочірній елемент тієї ж цілі. */
  leave: (key: string, inside?: boolean) => void;
  /** Кидок або кінець перетягування — усе гасимо. */
  cancel: () => void;
  /** Для тестів і підказок: ключ, для якого зараз заведено або спрацьовано. */
  armedKey: () => string | null;
};

type Timers = {
  set: (fn: () => void, ms: number) => unknown;
  clear: (h: unknown) => void;
};

const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

export function createHoverArmer(timers: Timers = realTimers): HoverArmer {
  let handle: unknown = null;
  let key: string | null = null;
  const clearTimer = () => { if (handle !== null) { timers.clear(handle); handle = null; } };
  const arm = (k: string, t: HoverTarget) => {
    clearTimer();
    key = k;
    handle = timers.set(() => {
      handle = null;
      t.fire();
      /* ключ лишається: та сама ціль удруге не спрацьовує, поки з неї не вийти */
      if (t.repeat && key === k) arm(k, t);
    }, t.ms);
  };
  return {
    enter: (k, t) => { if (key !== k) arm(k, t); },
    over: (k, t) => { if (key !== k) arm(k, t); },
    leave: (k, inside = false) => {
      if (inside) return;
      if (key === k) { clearTimer(); key = null; }
    },
    cancel: () => { clearTimer(); key = null; },
    armedKey: () => key,
  };
}
