/* ===== RadFlow — міжвкладкова дедуплікація звуку =====
   Одна бізнес-операція → не більше ОДНОГО звуку на весь браузер, навіть якщо
   відкрито кілька вкладок RadFlow. Координація ефемерна (BroadcastChannel,
   нічого не пишеться в storage); назовні виходять лише неперсональні хешовані
   dedupe-ключі (див. dedupeHash у lib/soundEvents.ts) — без ФІО, телефонів,
   досліджень чи id записів.

   Схема «перший зіграв — оголосив»: вкладка, що дійшла до відтворення, спершу
   відкидає ключі, які нещодавно оголосила інша вкладка, а свої оголошує ДО
   програвання. Вікна burst-агрегації в хуку мають випадковий джиттер, тож
   вкладки майже ніколи не флашать в ту саму мить. Відсутність BroadcastChannel
   (старий браузер) нічого не ламає — кожна вкладка просто звучить сама. */

type PlayedMsg = { t: "played"; keys: string[]; ts: number };

const SEEN_TTL_MS = 10000;

export class TabSoundDedupe {
  private chan: BroadcastChannel | null = null;
  private seen = new Map<string, number>();

  constructor(name = "rf-sound-v1") {
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
  }
}
