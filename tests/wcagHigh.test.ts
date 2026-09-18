/**
 * Статичні піни трьох High-знахідок WCAG-переаудиту 15.09
 * (`docs/audit/WCAG-static-2026-09-15.md`, рішення власника Р74-5 «лише High»).
 *
 * ⚠️ ЧОГО НЕ ДОВОДЯТЬ. Це текст компонентів, а не DOM і не скрінрідер: «атрибут
 *    стоїть» ≠ «NVDA мовчить про згорнуті рядки». Живу перевірку (клавіатура +
 *    NVDA, чек-лист §4 переаудиту) робить власник; ці піни тримають лише те, що
 *    правку не відкотили рефактором мовчки — той самий клас, що `codeOf`-сторожі.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { codeOf } from "./helpers/codeOf";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const code = (p: string) => codeOf(read(p));
/* CSS теж без коментарів (ревʼю с75, клас N20): закоментоване правило не сміє тримати пін. */
const css = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, " ");

describe("W-1 — згорнуті деталі рядка поза фокусом і деревом доступності (inert)", () => {
  it.each(["components/QueueBoard.tsx", "components/RadiologistBoard.tsx", "components/ReferrerBoard.tsx"])(
    "%s: єдина панель деталей несе inert={!expanded}",
    (file) => {
      const src = code(file);
      expect(src.split('className="qrow-detail-wrap" inert={!expanded}').length - 1).toBe(1);
      /* гола обгортка без inert — це і є дефект W-1 */
      expect(src).not.toMatch(/className="qrow-detail-wrap"\s*>/);
    }
  );
  it("CSS-згортання лишилось (анімацію висоти inert не замінює)", () => {
    const c = css("styles/prototype/radflow.css");
    expect(c).toContain(".qrow-detail-wrap { display: grid; grid-template-rows: 0fr;");
    expect(c).toContain(".qrow-item.open .qrow-detail-wrap { grid-template-rows: 1fr; }");
  });
});

describe("W-2 — функції лише для миші отримали клавіатурний шлях", () => {
  it("ReferrersManager: імʼя направника — <button aria-expanded>, клік по рядку для миші лишився", () => {
    const src = code("components/ReferrersManager.tsx");
    expect(src).toContain('<button type="button" className="rf-rowbtn" aria-expanded={expandable ? !!expanded : undefined} onClick={(e) => { e.stopPropagation(); onClick(); }}>{name}</button>');
    expect(src).toMatch(/<div onClick=\{onClick\} title=\{expandable \?/);
  });
  it("ReferralPortal: назва центру — <button aria-expanded>", () => {
    const src = code("components/ReferralPortal.tsx");
    expect(src).toContain('<button type="button" className="rf-rowbtn" aria-expanded={expandable ? !!expanded : undefined} onClick={(e) => { e.stopPropagation(); onClick(); }}>{c.name}</button>');
  });
  it.each([
    ["components/ReferrersManager.tsx", "AccessRowView"],
    ["components/ReferralPortal.tsx", "CenterRowView"],
  ])("%s: рядок — компонент модульного рівня, не функція всередині рендера (інакше кнопка ремонтується і фокус падає на body — HIGH ревʼю с75)", (file, name) => {
    const src = code(file);
    expect(src).toMatch(new RegExp("^function " + name + "\\(", "m"));
    expect(src).not.toMatch(/^\s+function Row\(/m);
    expect(src).not.toMatch(/<Row[\s>]/);
  });
  it("QueueBoard: видима кнопка «✎ Дані пацієнта» в деталях (span на імені — не єдиний шлях)", () => {
    const src = code("components/QueueBoard.tsx");
    expect(src).toContain('<button className="btn btn-secondary btn-sm" onClick={act(onEditPatient)} title="Редагувати ПІБ, телефон, вік, вагу">✎ Дані пацієнта</button>');
  });
  it(".rf-rowbtn — кнопка-як-текст без outline-override (кільце фокуса — глобальне)", () => {
    const c = css("styles/prototype/radflow.css");
    const at = c.indexOf(".rf-rowbtn {");
    expect(at).toBeGreaterThan(0);
    const block = c.slice(at, c.indexOf("}", at));
    expect(block).toContain("background: none; border: 0; padding: 0; margin: 0; font: inherit; color: inherit;");
    /* жодне правило на .rf-rowbtn (і :focus-visible, і :hover) не сміє гасити outline чи скидати все */
    expect(c).not.toMatch(/\.rf-rowbtn[^{]*\{[^}]*(outline\s*:\s*(none|0)|all\s*:\s*unset)/);
  });
});

describe("W-3 — статус дзвінка в колл-листі: гліф + текст, не лише колір", () => {
  const src = code("components/CallListBoard.tsx");
  it("StatusBadge рендерить бейдж .qd-call з іконкою (aria-hidden) і підписом", () => {
    expect(src).toContain('<span className={"qd-call cl-status " + m.cls} data-call-status={key}>');
    expect(src).toContain('<span aria-hidden="true">{m.icon}</span> {m.label}');
  });
  it("одного ☎ з кольором за статусом більше немає, title на span — теж", () => {
    expect(src).not.toMatch(/title=\{m\.label\}[^>]*>☎</);
    expect(src).not.toContain("CALL_COLOR");
  });
  it("усі пʼять статусів мають різні гліфи, ті самі, що на дошці черги (✗/✕ не розрізнити — ревʼю с75)", () => {
    const pick = (txt: string) => Object.fromEntries([...txt.matchAll(/^\s+(not_called|confirmed|no_answer|to_recall|declined):\s*\{ label: "[^"]+", cls: "[a-z]+", icon: "([^"]+)" \},?$/gm)].map((m) => [m[1], m[2]]));
    const cl = pick(src);
    const qb = pick(code("components/QueueBoard.tsx"));
    expect(Object.keys(cl).sort()).toEqual(["confirmed", "declined", "no_answer", "not_called", "to_recall"]);
    expect(new Set(Object.values(cl)).size).toBe(5);
    expect(cl).toEqual(qb);
    expect(Object.values(cl)).not.toContain("✗");
  });
  it("статус є і в розгорнутих деталях", () => {
    expect(src).toContain('<span className="cld-lab">Статус дзвінка</span><span className="cld-val"><StatusBadge status={p.call_status} /></span>');
  });
  it("колонка «Статус» розширена під текст (126px), бейдж переноситься, червоний читається", () => {
    const c = css("styles/prototype/radflow-screens.css");
    expect(c).toContain("grid-template-columns: 28px 50px 1.35fr 116px 1.75fr 58px 126px 1.1fr 88px;");
    expect(c).toMatch(/\.cl-status \{[^}]*font-size: 0\.6875rem;[^}]*white-space: normal;/);
    expect(c).toContain(".cl-status.red { color: #ff8c84; }");
  });
});
