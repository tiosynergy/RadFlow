/**
 * U-62 — політика перезапитів `useRealtimeRefetch`.
 *
 * ЧОМУ ЦЕ ІСНУЄ. Замір с57: хук має ДВАНАДЦЯТЬ споживачів і жодного
 * поведінкового сторожа. DOM-тестів у проєкті немає навмисно, тож правила
 * винесені в чисті функції — і пінуються тут. Плюс лексичний пін на те, що
 * хук КЛИЧЕ саме їх, а не тримає копію логіки поруч.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { codeOf } from "./helpers/codeOf";
import {
  POLL_BASE_MS,
  POLL_MAX_MS,
  RETURN_DEDUPE_MS,
  SOCKET_STABLE_MS,
  nextPollDelay,
  shouldRefetchOnReturn,
  shouldResetBackoff,
} from "@/lib/realtimeRefetchPolicy";

const hook = codeOf(
  readFileSync(resolve(process.cwd(), "lib/useRealtimeRefetch.ts"), "utf8")
);

describe("U-62/Д1 — повернення у вкладку рахується ОДИН раз", () => {
  it("перше повернення завжди перезапитує", () => {
    expect(shouldRefetchOnReturn(null, 1_000)).toBe(true);
  });

  it("друга подія того самого повернення — НЕ перезапитує", () => {
    /* Саме цей випадок і був дефектом: браузер шле visibilitychange і focus
       підряд, різниця — одиниці мілісекунд. */
    expect(shouldRefetchOnReturn(1_000, 1_005)).toBe(false);
    expect(shouldRefetchOnReturn(1_000, 1_000 + RETURN_DEDUPE_MS - 1)).toBe(false);
  });

  it("справжнє наступне повернення — перезапитує", () => {
    expect(shouldRefetchOnReturn(1_000, 1_000 + RETURN_DEDUPE_MS)).toBe(true);
    expect(shouldRefetchOnReturn(1_000, 60_000)).toBe(true);
  });

  it("стрибок годинника НАЗАД не глушить перезапит (fail-open)", () => {
    /* Ціна зайвого перезапиту менша за ціну застиглого екрана. */
    expect(shouldRefetchOnReturn(10_000, 9_000)).toBe(true);
  });

  it("зазор — секунда, і це не випадкове число", () => {
    expect(RETURN_DEDUPE_MS).toBe(1000);
  });
});

describe("U-62/Д3 — backoff і його скид", () => {
  it("крок множить на півтора і впирається в стелю", () => {
    expect(nextPollDelay(POLL_BASE_MS)).toBe(12_000);
    expect(nextPollDelay(12_000)).toBe(18_000);
    expect(nextPollDelay(POLL_MAX_MS)).toBe(POLL_MAX_MS);
    expect(nextPollDelay(59_000)).toBe(POLL_MAX_MS);
  });

  it("сміттєвий вхід не обнуляє крок", () => {
    /* Інакше NaN тихо зробив би затримку NaN, а setTimeout(NaN) = 0 мс, тобто
       клієнт пішов би в цикл без пауз. */
    expect(nextPollDelay(Number.NaN)).toBe(nextPollDelay(POLL_BASE_MS));
    expect(nextPollDelay(0)).toBe(nextPollDelay(POLL_BASE_MS));
    expect(nextPollDelay(-5)).toBe(nextPollDelay(POLL_BASE_MS));
  });

  it("дребезг сокета backoff НЕ скидає", () => {
    /* Був дефект: `stopPolling()` ставив 8 с на КОЖНОМУ SUBSCRIBED. */
    expect(shouldResetBackoff(1_000, 1_500)).toBe(false);
    expect(shouldResetBackoff(1_000, 1_000 + SOCKET_STABLE_MS - 1)).toBe(false);
  });

  it("стабільна підписка backoff скидає", () => {
    expect(shouldResetBackoff(1_000, 1_000 + SOCKET_STABLE_MS)).toBe(true);
    expect(shouldResetBackoff(1_000, 10 * 60_000)).toBe(true);
  });

  it("підписки не було — скидати нічого", () => {
    expect(shouldResetBackoff(null, 999_999)).toBe(false);
  });

  it("стрибок годинника назад НЕ вважається стабільністю (fail-closed)", () => {
    /* Тут fail-closed навмисно і в інший бік, ніж у Д1: зайвий скид повертає
       клієнта до частого поллінга, тобто шкодить серверу, а не людині. */
    expect(shouldResetBackoff(10_000, 9_000)).toBe(false);
  });
});

describe("U-62 — хук користується політикою, а не копією логіки", () => {
  it("хук імпортує саме ці функції", () => {
    expect(hook).toMatch(/from "@\/lib\/realtimeRefetchPolicy"/);
    for (const name of ["shouldRefetchOnReturn", "shouldResetBackoff", "nextPollDelay", "POLL_BASE_MS"]) {
      expect(hook, `хук більше не кличе ${name}`).toContain(name);
    }
  });

  it("у хуку не лишилось голих чисел backoff", () => {
    /* Пін проти регресу «повернули літерал»: 8000 і 60000 мусять жити в
       політиці, інакше правило й сторож розійдуться мовчки. */
    expect(hook, "у хуку знову зʼявився літерал 8000").not.toMatch(/pollDelay\s*=\s*8000/);
    expect(hook, "у хуку знову зʼявилась стеля літералом").not.toMatch(/POLL_MAX\s*=\s*60000/);
  });

  it("обидві події повернення ведуть в ОДИН дедуплікований обробник", () => {
    /* Дефект був саме в тому, що слухачів два, а лічильника не було. */
    expect(hook).toMatch(/addEventListener\("visibilitychange", onVisible\)/);
    expect(hook).toMatch(/addEventListener\("focus", onVisible\)/);
    expect(hook).toMatch(/shouldRefetchOnReturn\(lastReturnAt, now\)/);
  });

  it("скид backoff стоїть у гілці ОБРИВУ, а не SUBSCRIBED", () => {
    /* Якщо скид повернеться в stopPolling(), дефект відродиться цілком. */
    const stop = hook.slice(hook.indexOf("const stopPolling"), hook.indexOf("const startPolling"));
    expect(stop, "скид backoff знову в stopPolling").not.toMatch(/pollDelay\s*=/);
    expect(hook).toMatch(/if \(shouldResetBackoff\(subscribedAt, Date\.now\(\)\)\) pollDelay = POLL_BASE_MS;/);
  });
});
