/* Тести чистої логіки деплой-гейта міграцій (RF-05, пакет 0142).
   planGate/readDiskMigrations живуть у scripts/migration-gate-lib.mjs і БД
   не чіпають; CLI-обгортка (migration-gate.mjs) сюди не імпортується —
   вона безумовно виконує main(). */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { planGate, readDiskMigrations } from "../scripts/migration-gate-lib.mjs";

type Row = { name: string; md5: string | null };

const d = (name: string, md5 = "aa"): Row => ({ name, md5 });

describe("planGate", () => {
  it("усе збігається → ok, без failures і stamps", () => {
    const r = planGate([d("0001_a.sql"), d("0002_b.sql", "bb")],
                       [d("0001_a.sql"), d("0002_b.sql", "bb")]);
    expect(r.failures).toEqual([]);
    expect(r.stamps).toEqual([]);
    expect(r.ok).toEqual(["0001_a.sql", "0002_b.sql"]);
  });

  it("файл на диску без запису в леджері → НЕ НАКАТАНО", () => {
    const r = planGate([d("0001_a.sql"), d("0143_new.sql")], [d("0001_a.sql")]);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain("НЕ НАКАТАНО");
    expect(r.failures[0]).toContain("0143_new.sql");
  });

  it("запис у леджері без файла → НЕМАЄ ФАЙЛА (перейменування/втрата)", () => {
    const r = planGate([d("0001_a.sql")], [d("0001_a.sql"), d("0002_gone.sql")]);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain("НЕМАЄ ФАЙЛА");
    expect(r.failures[0]).toContain("0002_gone.sql");
  });

  it("md5 null у леджері → у stamps, не у failures (перший прогін)", () => {
    const r = planGate([d("0001_a.sql", "real")], [{ name: "0001_a.sql", md5: null }]);
    expect(r.failures).toEqual([]);
    expect(r.stamps).toEqual([{ name: "0001_a.sql", md5: "real" }]);
  });

  it("md5 розійшовся → файл правили після накату", () => {
    const r = planGate([d("0001_a.sql", "disk")], [d("0001_a.sql", "ledger")]);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain("MD5 РОЗІЙШОВСЯ");
  });

  it("перейменування = одночасно НЕ НАКАТАНО + НЕМАЄ ФАЙЛА (обидві сторони видно)", () => {
    const r = planGate([d("0002_renamed.sql")], [d("0002_old_name.sql")]);
    expect(r.failures).toHaveLength(2);
    expect(r.failures.join("\n")).toContain("НЕ НАКАТАНО");
    expect(r.failures.join("\n")).toContain("НЕМАЄ ФАЙЛА");
  });

  it("порожній леджер + непорожній диск → усе НЕ НАКАТАНО (не вакуумний тест)", () => {
    const r = planGate([d("0001_a.sql"), d("0002_b.sql")], []);
    expect(r.failures).toHaveLength(2);
  });

  it("порожні диск і леджер → чисто (0 усього)", () => {
    const r = planGate([], []);
    expect(r.failures).toEqual([]);
    expect(r.ok).toEqual([]);
  });

  it("імʼя поза каноном → failure (файл не випадає з-під гейта мовчки)", () => {
    const r = planGate([d("0001_a.sql")], [d("0001_a.sql")], ["143_typo.sql"]);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain("ІМʼЯ ПОЗА КАНОНОМ");
    expect(r.failures[0]).toContain("143_typo.sql");
  });
});

describe("readDiskMigrations (герметична фікстура)", () => {
  it("бачить NNNN_*.sql з md5; PRECHECK і не-.sql ігнорує; криві імена → badNames", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rf-gate-"));
    try {
      writeFileSync(path.join(dir, "0001_init.sql"), "select 1;");
      writeFileSync(path.join(dir, "0002_b.sql"), "select 2;");
      writeFileSync(path.join(dir, "0064_PRECHECK.sql"), "-- не міграція");
      writeFileSync(path.join(dir, "ROLLBACK.md"), "# not sql");
      writeFileSync(path.join(dir, "143_typo.sql"), "select 3;");
      writeFileSync(path.join(dir, "0003nounderscore.sql"), "select 4;");
      const { files, badNames } = readDiskMigrations(dir);
      expect(files.map((f) => f.name)).toEqual(["0001_init.sql", "0002_b.sql"]);
      for (const f of files) expect(f.md5).toMatch(/^[0-9a-f]{32}$/);
      expect(badNames).toEqual(["0003nounderscore.sql", "143_typo.sql"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("реальна тека проєкту: 0001 на місці, 0142 у списку, PRECHECK-ів немає, кривих імен нуль", () => {
    const dir = path.join(__dirname, "..", "supabase", "migrations");
    const { files, badNames } = readDiskMigrations(dir);
    const names = files.map((f) => f.name);
    expect(names[0]).toBe("0001_init.sql");
    expect(names).toContain("0142_migration_ledger.sql");
    expect(names.some((n) => n.includes("PRECHECK"))).toBe(false);
    expect(badNames).toEqual([]);
  });
});
