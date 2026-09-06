"use client";

import { useSyncExternalStore } from "react";
import { isDocumentShown } from "@/lib/ackVisibility";

/**
 * Видимість документа як зовнішнє сховище.
 *
 * ⚠️ ЧОМУ ЧЕРЕЗ ПІДСТАВНИЙ HOST, а не прямо по `document`: інакше сховище
 *    неперевіряне взагалі. Ревʼю с58 назвало три правки, кожна на один
 *    символ, після яких слухач не навішується або нікого не будить, а обидва
 *    лексичні піни лишаються зеленими. Тепер поведінку сховища знімає
 *    `tests/ackVisibility.test.ts` на рукописному хості — без DOM, тобто не
 *    порушуючи канон `vitest.config.ts`.
 */
export type VisibilityHost = {
  visibilityState: string;
  addEventListener: (type: "visibilitychange", cb: () => void) => void;
  removeEventListener: (type: "visibilitychange", cb: () => void) => void;
};

export type VisibilityStore = {
  subscribe: (cb: () => void) => () => void;
  getSnapshot: () => boolean;
  /** Тільки для сторожа: скільки живих підписників. */
  listenerCount: () => number;
};

export function createVisibilityStore(host: VisibilityHost | null): VisibilityStore {
  const listeners = new Set<() => void>();
  let attached = false;
  const emit = () => { for (const l of [...listeners]) l(); };
  return {
    subscribe(cb) {
      if (!attached && host) {
        host.addEventListener("visibilitychange", emit);
        attached = true;
      }
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    getSnapshot: () => isDocumentShown(host ? host.visibilityState : undefined),
    listenerCount: () => listeners.size,
  };
}

/* Один слухач на застосунок. */
const store = createVisibilityStore(typeof document === "undefined" ? null : document);

/* ⚠️ ЗАГЛУШКИ ДЛЯ ВИМКНЕНОГО СПОЖИВАЧА — оголошені на модулі, а не в тілі
   хука: інакше кожен рендер давав би нову функцію `subscribe`, і React
   перепідписувався б на порожньому місці. */
const NEVER = () => () => {};
const SHOWN = () => true;

/* ⚠️ На гідратації React бере САМЕ це значення, і воно fail-OPEN — на відміну
   від `isDocumentShown`. Так і задумано: `false` дав би зайвий ререндер на
   гідратації в КОЖНОГО споживача, а їх тринадцять, із них чотири порядкові.
   Ціна цього вибору названа чесно: перший клієнтський знімок каже «показано»
   навіть у фоновій вкладці, і сьогодні це не стріляє ЛИШЕ тому, що індекс
   непрочитаного на першому коміті завжди `loading` (тобто `ackGate` дає
   `wait`). Засієте індекс із SSR або з кешу — U-59 повернеться саме тут. */
function getServerSnapshot(): boolean {
  return true;
}

/**
 * Чи показано документ прямо зараз.
 *
 * @param enabled чи може відповідь узагалі на щось вплинути.
 *
 * ⚠️ `enabled` — це не мікрооптимізація, а замір (ревʼю с58). Місць виклику
 *    `useAckWhenVisible` тринадцять, і ЧОТИРИ з них порядкові (рядок дошки
 *    черги, скасований рядок, два рядки дошки радіолога) — тобто підписників
 *    не константа, а N. Без цього прапорця кожне перемикання вкладки будило б
 *    ререндером кожен рядок дошки, двічі за круг «пішов — повернувся», хоча в
 *    згорнутого рядка наслідок гейта завжди один і той самий (`collapse`).
 *    Це та сама холоста робота, яку прибирав U-62, тільки іншим входом.
 *
 * ⚠️ При `enabled === false` віддаємо `true`, і це БЕЗПЕЧНО не саме по собі, а
 *    тому, що вимкнено рівно тоді, коли `!scope || !visible` — а там `ackGate`
 *    дає `collapse` незалежно від видимості документа.
 */
export function useDocumentVisible(enabled: boolean): boolean {
  return useSyncExternalStore(
    enabled ? store.subscribe : NEVER,
    enabled ? store.getSnapshot : SHOWN,
    getServerSnapshot,
  );
}
