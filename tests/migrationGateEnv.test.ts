/* ===== RF-05 (пакет 39, с59): гейт міграцій не сміє бути fail-open =====

   До пакета 39 `scripts/migration-gate.mjs` мав два обходи, і обидва були
   МОВЧАЗНІ: `RADFLOW_SKIP_MIGRATION_GATE=1` виходив із WARN у будь-якому
   середовищі (зокрема у прод-збірці Vercel), а `--build` без ключів робив
   «мʼякий пропуск» — на ньому CI без секретів проходив на кожному прогоні.
   Тепер рішення живе в чистій функції `gateEnvDecision`, і тут воно
   перевіряється ВСІМА комбінаціями, а не двома щасливими.

   Два шари: (1) таблиця рішень — поведінково; (2) підпроцес — що CLI справді
   виходить з кодом 1 на Vercel зі skip-змінною (цей шлях не залежить від
   `.env.local` на машині, бо перевіряється ДО ключів); (3) лексичні піни —
   що CLI кличе саме цю функцію і не має власних `return` до неї, і що
   workflow каже про пропуск ЯВНО. */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gateEnvDecision } from "../scripts/migration-gate-lib.mjs";

type Env = Parameters<typeof gateEnvDecision>[0];
const base: Env = { buildMode: true, vercel: false, skip: false, noDb: false, hasUrl: true, hasKey: true };
const d = (over: Partial<Env>) => gateEnvDecision({ ...base, ...over });

describe("gateEnvDecision — на Vercel обходів НЕМАЄ", () => {
  it("ключі є, нічого не просять → run", () => {
    expect(d({ vercel: true })).toEqual({ action: "run", message: null });
  });
  it("RADFLOW_SKIP_MIGRATION_GATE=1 → fail (раніше — WARN і exit 0)", () => {
    const r = d({ vercel: true, skip: true });
    expect(r.action).toBe("fail");
    expect(r.message).toContain("ВІДМОВА");
    expect(r.message).toContain("RADFLOW_SKIP_MIGRATION_GATE");
  });
  it("RADFLOW_GATE_NO_DB=1 → fail", () => {
    const r = d({ vercel: true, noDb: true });
    expect(r.action).toBe("fail");
    expect(r.message).toContain("RADFLOW_GATE_NO_DB");
  });
  it("без ключів → fail (раніше — «мʼякий пропуск»)", () => {
    for (const over of [{ hasUrl: false }, { hasKey: false }, { hasUrl: false, hasKey: false }]) {
      const r = d({ vercel: true, ...over });
      expect(r.action, JSON.stringify(over)).toBe("fail");
      expect(r.message).toContain("SUPABASE_SERVICE_ROLE_KEY");
    }
  });
  it("skip + noDb + без ключів разом → усе одно fail, і першим названо skip", () => {
    const r = d({ vercel: true, skip: true, noDb: true, hasUrl: false, hasKey: false });
    expect(r.action).toBe("fail");
    expect(r.message).toContain("RADFLOW_SKIP_MIGRATION_GATE");
  });
});

describe("gateEnvDecision — поза Vercel пропуск лише ЯВНИЙ і лише для --build", () => {
  it("ключі є → run у будь-якому режимі", () => {
    expect(d({}).action).toBe("run");
    expect(d({ buildMode: false }).action).toBe("run");
  });
  it("skip у --build → skip із WARN, у якому є слова «БЕЗ ЗВІРКИ»", () => {
    const r = d({ skip: true });
    expect(r.action).toBe("skip");
    expect(r.message).toContain("WARN");
    expect(r.message).toContain("БЕЗ ЗВІРКИ");
  });
  it("skip БЕЗ --build (db:gate / db:gate:check) → fail: перевірку не обходять", () => {
    const r = d({ skip: true, buildMode: false });
    expect(r.action).toBe("fail");
    expect(r.message).toContain("--build");
  });
  it("без ключів у --build без явного noDb → fail і підказка про RADFLOW_GATE_NO_DB", () => {
    const r = d({ hasKey: false });
    expect(r.action).toBe("fail");
    expect(r.message).toContain("RADFLOW_GATE_NO_DB=1");
  });
  it("без ключів у --build з RADFLOW_GATE_NO_DB=1 → skip, і рядок каже «БЕЗ ЗВІРКИ»", () => {
    const r = d({ hasKey: false, hasUrl: false, noDb: true });
    expect(r.action).toBe("skip");
    expect(r.message).toContain("БЕЗ ЗВІРКИ");
  });
  it("без ключів БЕЗ --build → fail навіть із noDb (перевірка без БД не існує)", () => {
    expect(d({ hasKey: false, buildMode: false, noDb: true }).action).toBe("fail");
  });
  it("noDb при наявних ключах — не пропуск: ключі є, звіряємо", () => {
    expect(d({ noDb: true }).action).toBe("run");
  });
});

/* ⚠️ Підпроцес: реальний CLI, реальний код виходу. Шлях «Vercel + skip»
   вирішується ДО читання ключів, тому не залежить від `.env.local` на машині
   (на машині власника ключі Є — і саме тому шлях «без ключів» тут не ганяємо:
   він пішов би в мережу). Зелена база: той самий CLI без VERCEL і зі skip у
   --build мусить вийти з 0 і надрукувати WARN — інакше «exit 1» нижче доводив
   би лише те, що скрипт не запускається. */
describe("migration-gate.mjs — підпроцес", () => {
  const cli = resolve(process.cwd(), "scripts/migration-gate.mjs");
  /* Ревʼю А/Б пакета 39: `VERCEL: ""` — це НЕ «не задано»: loadEnvLocal()
     добиває будь-яке falsy значення з .env.local. Тож три змінні саме
     ВИДАЛЯЮТЬСЯ з копії середовища, а не обнуляються. */
  const run = (env: Record<string, string>) => {
    const clean: NodeJS.ProcessEnv = { ...process.env };
    for (const k of ["VERCEL", "RADFLOW_SKIP_MIGRATION_GATE", "RADFLOW_GATE_NO_DB"]) delete clean[k];
    return spawnSync(process.execPath, [cli, "--build"], {
      cwd: process.cwd(), encoding: "utf8", timeout: 30000, env: { ...clean, ...env },
    });
  };

  it("зелена база: поза Vercel skip у --build → exit 0 і WARN «БЕЗ ЗВІРКИ»", () => {
    const r = run({ RADFLOW_SKIP_MIGRATION_GATE: "1" });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stderr + r.stdout).toContain("БЕЗ ЗВІРКИ");
  });
  it("Vercel + RADFLOW_SKIP_MIGRATION_GATE=1 → exit 1 і «ВІДМОВА»", () => {
    const r = run({ VERCEL: "1", RADFLOW_SKIP_MIGRATION_GATE: "1" });
    expect(r.status, r.stderr + r.stdout).toBe(1);
    expect(r.stderr).toContain("ВІДМОВА");
  });
  it("Vercel + RADFLOW_GATE_NO_DB=1 → exit 1", () => {
    const r = run({ VERCEL: "1", RADFLOW_GATE_NO_DB: "1" });
    expect(r.status, r.stderr + r.stdout).toBe(1);
    expect(r.stderr).toContain("RADFLOW_GATE_NO_DB");
  });
});

/* Лексичні піни — межа названа: CLI не має двійника БД, тож те, що після
   `fail` стоїть саме `process.exit(1)` і що до рішення немає ЖОДНОГО
   `return`, стережеться текстом. */
describe("migration-gate.mjs — CLI користується рішенням, а не власними return-ами", () => {
  const src = readFileSync(resolve(process.cwd(), "scripts/migration-gate.mjs"), "utf8");
  const main = src.slice(src.indexOf("async function main()"), src.indexOf("const { createClient }"));

  it("до першого запиту в базу — рівно один виклик gateEnvDecision і рівно один return (на skip)", () => {
    expect(main.match(/gateEnvDecision\(/g) || []).toHaveLength(1);
    expect(main.match(/^\s*return;\s*$/gm) || [], "зайвий return до рішення — це fail-open").toHaveLength(1);
  });
  /* Ревʼю А пакета 39: пін «рівно один return у рядку» не бачив однорядкового
     `if (…) return;` чи `process.exit(0)` ДО рішення. Тому ДО виклику
     gateEnvDecision — жодного return і жодного exit узагалі (коментарі зрізано). */
  it("ДО виклику gateEnvDecision немає ЖОДНОГО return / process.exit", () => {
    const pre = main.slice(0, main.indexOf("gateEnvDecision("))
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(pre.match(/\breturn\b|process\.exit\(/g), "вихід із main() до рішення — це fail-open").toBeNull();
  });
  it("дія fail → process.exit(1), дія skip → return; жодного пропуску без рішення", () => {
    expect(main).toMatch(/decision\.action === "fail"[\s\S]{0,120}process\.exit\(1\)/);
    expect(main).toMatch(/decision\.action === "skip"[\s\S]{0,80}return;/);
    expect(main).not.toMatch(/RADFLOW_SKIP_MIGRATION_GATE === "1"\)\s*\{[\s\S]{0,200}return;/);
  });
  it("усі шість входів рішення беруться з env/args, VERCEL — з process.env.VERCEL", () => {
    for (const k of ["buildMode", 'process.env.VERCEL === "1"', 'RADFLOW_SKIP_MIGRATION_GATE === "1"', 'RADFLOW_GATE_NO_DB === "1"']) {
      expect(main, k).toContain(k);
    }
    // не «hasUrl: true» (ревʼю А): ключі — з env, а не з чесного слова
    expect(main).toMatch(/hasUrl:\s*Boolean\(url\)/);
    expect(main).toMatch(/hasKey:\s*Boolean\(key\)/);
    expect(main).toMatch(/const url = process\.env\.NEXT_PUBLIC_SUPABASE_URL;/);
    expect(main).toMatch(/const key = process\.env\.SUPABASE_SERVICE_ROLE_KEY;/);
  });
  it("gate.yml називає пропуск явно: RADFLOW_GATE_NO_DB на кроці build", () => {
    const yml = readFileSync(resolve(process.cwd(), ".github/workflows/gate.yml"), "utf8");
    const buildStep = yml.slice(yml.indexOf("npm run build"));
    expect(buildStep).toMatch(/RADFLOW_GATE_NO_DB:\s*"1"/);
    expect(yml).not.toContain("мягкий пропуск\n#  (проверено)");
  });
});
