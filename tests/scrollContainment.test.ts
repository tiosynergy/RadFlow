/* ===== с78 — панелі прокрутки тримають свої absolute-нащадки =====
   Баг (власник, 24.09): на /queue, коли список доходив до кінця, колесо
   прокручувало ВСЮ сторінку в порожнечу. Причина (замір у Chromium):
   `.rf-vh` (position:absolute) і прихований input у `.rf-check` не мали
   позиціонованого предка, якорились до документа і розпирали його висоту
   (вікно 900 px → документ 8970 px). Розбір —
   docs/audit/PR-s78-queue-scroll-containment.md.

   Статичні піни по CSS у стилі wcagMedium.test.ts: мутація, що знімає
   властивість, червонить рівно свій тест. Живий замір висоти документа на
   проді вони НЕ замінюють — він записаний у PR-доці. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** Тіло правила верхнього рівня з ТОЧНО цим селектором. Правила в медіа-запитах
 *  мають відступ, тож `^` їх не бере — пінимо базове правило. */
const ruleBody = (css: string, sel: string): string => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const all = [...css.matchAll(new RegExp(`^${esc}\\s*\\{([^}]*)\\}`, "gm"))];
  expect(all.length, `${sel}: рівно одне правило верхнього рівня`).toBe(1);
  return all[0][1];
};

const POSITION_RELATIVE = /(^|;|\s)position:\s*relative\s*;/;

describe("с78 — оболонка не дає absolute-нащадкам розпирати документ", () => {
  it.each([
    ["styles/prototype/radflow.css", ".app"],
    ["styles/prototype/radflow-wizard.css", ".wiz"],
  ])("%s %s — оболонка: position: relative разом з overflow: hidden", (file, sel) => {
    const body = ruleBody(read(file), sel);
    expect(body).toMatch(POSITION_RELATIVE);
    expect(body).toMatch(/overflow:\s*hidden\s*;/);
  });

  it.each([
    ["styles/prototype/radflow.css", ".content"],
    ["styles/prototype/radflow.css", ".rpanel"],
    ["styles/prototype/radflow.css", ".sb-nav"],
    ["styles/prototype/radflow-screens.css", ".content-full"],
    ["styles/prototype/radflow-wizard.css", ".wiz-main"],
    ["styles/prototype/radflow-wizard.css", ".wiz-steps"],
  ])("%s %s — панель прокрутки: position: relative + overscroll-behavior-y: contain", (file, sel) => {
    const body = ruleBody(read(file), sel);
    expect(body).toMatch(/overflow-y:\s*auto/);
    expect(body).toMatch(POSITION_RELATIVE);
    expect(body).toMatch(/overscroll-behavior-y:\s*contain\s*;/);
  });

  it("radflow.css: .rf-check — position: relative, бо його input — position: absolute", () => {
    const css = read("styles/prototype/radflow.css");
    expect(ruleBody(css, ".rf-check input")).toMatch(/position:\s*absolute/);
    expect(ruleBody(css, ".rf-check")).toMatch(POSITION_RELATIVE);
  });

  it("radflow.css: .rf-dot — position: relative (підпис .rf-vh обрізається разом з хостом, напр. line-clamp у .pp)", () => {
    expect(ruleBody(read("styles/prototype/radflow.css"), ".rf-dot")).toMatch(POSITION_RELATIVE);
  });

  it("radflow.css: .topbar — position: relative + z-index: 1 (кільце фокуса кнопок шапки не ховається під позиціонованими панелями)", () => {
    const body = ruleBody(read("styles/prototype/radflow.css"), ".topbar");
    expect(body).toMatch(POSITION_RELATIVE);
    expect(body).toMatch(/(^|;|\s)z-index:\s*1\s*;/);
  });
});
