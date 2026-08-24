/* ===== RadFlow — міжвкладкова дедуплікація звуку =====
   Одна бізнес-операція → не більше ОДНОГО звуку на весь браузер, навіть якщо
   відкрито кілька вкладок RadFlow. Координація ефемерна (BroadcastChannel,
   нічого не пишеться в storage); назовні виходять лише неперсональні хешовані
   dedupe-ключі (див. dedupeHash у lib/soundEvents.ts) — без ФІО, телефонів,
   досліджень чи id записів.

   ОСНОВНИЙ арбітр — Web Locks (`claimAsync`): імʼя локу і Є хеш події
   (`rf-sound-v1:<hash>`), тож «право зіграти цю подію» видає БРАУЗЕР, атомарно
   і на весь профіль. Хто дістав лок — грає й тримає його TTL; решта одразу
   отримує null і мовчить. Локи живуть у памʼяті й знімаються самі, коли вкладку
   закрито, — тому обіцянка «нічого не пишеться в storage» лишається чинною.

   Запасна схема «перший зіграв — оголосив» (`claim`, BroadcastChannel) працює
   там, де Web Locks немає (старий Safari, небезпечний контекст). Вона НЕ дає
   гарантії: доставка каналу асинхронна, і дві вкладки, що флашать в одну мить,
   обидві бачать порожній `seen` і обидві грають — саме цей дубль відтворено в
   с37. Джиттер вікна burst у хуку лише зменшує ймовірність, не прибирає її.

   Між РІЗНИМИ профілями та інкогніто дедуп неможливий у принципі: і канал, і
   локи ізольовані по origin+профіль. Це відоме обмеження, не дефект. */

type PlayedMsg = { t: "played"; keys: string[]; ts: number };

/** Мінімум із LockManager, який нам потрібен (і який легко підмінити в тестах). */
export type LockManagerLike = {
  request(
    name: string,
    options: { ifAvailable?: boolean },
    cb: (lock: unknown) => unknown,
  ): Promise<unknown>;
};

export type DedupeOpts = {
  /** За замовчуванням — `navigator.locks`. Тести підсовують свій менеджер. */
  locks?: LockManagerLike | null;
  /** Скільки тримати лок ключа (= горизонт «цю подію вже зіграно»). */
  holdMs?: number;
};

const SEEN_TTL_MS = 10000;
const LOCK_PREFIX = "rf-sound-v1:";

/** Web Locks є не всюди (старий Safari) і кидає в небезпечному контексті. */
function defaultLocks(): LockManagerLike | null {
  try {
    const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { locks?: unknown }) : null;
    const lm = nav?.locks as LockManagerLike | undefined;
    return lm && typeof lm.request === "function" ? lm : null;
  } catch {
    return null;
  }
}

export class TabSoundDedupe {
  private chan: BroadcastChannel | null = null;
  private seen = new Map<string, number>();
  private locks: LockManagerLike | null;
  private holdMs: number;
  /** Відпускачі власних локів — щоб close() не тримав ключі до кінця TTL. */
  private holders = new Set<() => void>();
  private timers = new Map<() => void, ReturnType<typeof setTimeout>>();

  constructor(name = "rf-sound-v1", opts: DedupeOpts = {}) {
    this.holdMs = opts.holdMs ?? SEEN_TTL_MS;
    this.locks = opts.locks !== undefined ? opts.locks : defaultLocks();
    try {
      if (typeof BroadcastChannel !== "undefined") {
        this.chan = new BroadcastChannel(name);
        this.chan.onmessage = (e: MessageEvent) => this.receive(e ? (e.data as PlayedMsg) : null);
      }
    } catch {
      this.chan = null;
    }
  }

  /** Обробити повідомлення іншої вкладки (окремо — для тестів без каналу). */
  receive(msg: PlayedMsg | null | undefined, now: number = Date.now()): void {
    if (!msg || msg.t !== "played" || !Array.isArray(msg.keys)) return;
    for (const k of msg.keys) if (typeof k === "string") this.seen.set(k, now);
    this.purge(now);
  }

  /** Відфільтрувати ключі, вже зіграні іншою вкладкою, та оголосити решту своїми. */
  claim(keys: readonly string[], now: number = Date.now()): string[] {
    this.purge(now);
    const mine = keys.filter((k) => !this.seen.has(k));
    if (mine.length && this.chan) {
      try {
        this.chan.postMessage({ t: "played", keys: mine, ts: now } satisfies PlayedMsg);
      } catch {
        /* канал міг закритись — граємо самі */
      }
    }
    return mine;
  }

  /** ОСНОВНИЙ шлях: право зіграти кожен ключ видає браузер (Web Locks).
   *  Повертає ключі, що дісталися ЦІЙ вкладці; порожньо = грає інша.
   *  ⚠️ Чекаємо МОМЕНТ видачі локу, а не завершення request: колбек тримає лок
   *  усі holdMs, тож await на самому request затримав би звук на 10 секунд. */
  async claimAsync(keys: readonly string[], now: number = Date.now()): Promise<string[]> {
    const lm = this.locks;
    if (!lm) return this.claim(keys, now); // старий браузер → запасна схема
    const grants = keys.map(
      (k) =>
        new Promise<string | null>((resolve) => {
          let settled = false;
          const grant = (ok: boolean) => {
            if (settled) return;
            settled = true;
            resolve(ok ? k : null);
          };
          try {
            void lm
              .request(LOCK_PREFIX + k, { ifAvailable: true }, (lock) => {
                if (!lock) {
                  grant(false);
                  return;
                }
                grant(true);
                return new Promise<void>((release) => {
                  this.holders.add(release);
                  this.timers.set(release, setTimeout(() => this.releaseHold(release), this.holdMs));
                });
              })
              .catch(() => grant(true));
          } catch {
            /* Відмова САМОГО арбітра (SecurityError, AbortError) — не те саме,
               що «лок дістався іншому». Вона однакова в УСІХ вкладках, тож
               мовчання тут вимкнуло б звук цілком. Обираємо дубль, не тишу. */
            grant(true);
          }
        }),
    );
    const mine = await Promise.all(grants);
    return mine.filter((k): k is string => k !== null);
  }

  private releaseHold(release: () => void): void {
    const t = this.timers.get(release);
    if (t !== undefined) clearTimeout(t);
    this.timers.delete(release);
    this.holders.delete(release);
    release();
  }

  private purge(now: number): void {
    for (const [k, ts] of this.seen) if (now - ts > SEEN_TTL_MS) this.seen.delete(k);
  }

  close(): void {
    try {
      this.chan?.close();
    } catch {
      /* ignore */
    }
    this.chan = null;
    /* Розмонтування дошки НЕ має тримати ключі чужих вкладок до кінця TTL. */
    for (const release of [...this.holders]) this.releaseHold(release);
  }
}
