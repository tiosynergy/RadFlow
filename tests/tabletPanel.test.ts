/* ===== с79 — Н-11 (права панель на ≤1240 px), Н-12 (вертикальні відступи .topbar),
   Н-13 (≤480 px: «☰» не лягає на шапку); ревʼю р2 — кільце фокуса біля краю
   панелей прокрутки й імена в картках панелі =====
   Н-11. `@media (max-width: 1240px) { .rpanel { display: none } }` стояло ВИЩЕ
   базового `.rpanel { … display: flex … }` з тією ж специфічністю і програвало.
   Рішення власника (с79) — НЕ ховати, а зробити панель другим рядком під
   списком: `1fr fit-content(40%)`, панель зі своєю прокруткою.
   Н-12. У `.topbar` пізніший `padding: 0 22px` обнуляв `padding-top/bottom: 4px`
   того ж правила; у compact верх кільця фокуса «＋ Новий запис» був на y ≈ −3.7.
   Н-13. На ≤480 px фіксована «☰» лягала на заголовок: правила щільності (0,2,1)
   перебивали мобільний відступ шапки (0,1,0). Ревʼю р2: місце під «☰» резервує
   лише рядок заголовка (.topbar > .tb-title — відступ і min-height), а не вся
   шапка, інакше при шрифті 200% перенесені кнопки виходили за правий край.
   Ревʼю р2 ще: scroll-padding-block на панелях прокрутки (кільце фокуса не
   зрізає їхній край) і перенос імен у картках панелі на ≤1240 px.

   Як перевіряємо — маленький КАСКАД, а не пошук підрядка:
   • CSS чотирьох файлів розбирається на правила з медіа-умовою і порядком;
     ⚠️ коментарі вирізаються ДО розбору — пін, який може задовольнити коментар,
     — неправда; вкладене правило чи @-блок у тілі правила (CSS nesting) —
     падіння з назвою, а не тиша;
   • селектори звіряються з МОДЕЛЛЮ: теги, класи, атрибути, предки, попередні
     сусіди. Оболонка (.main > .topbar > .tb-title, .content-wrap > .content +
     .rpanel) звірена з TSX через AST TypeScript (тест «модель звірена з TSX»);
     ланцюжки предків імен у картках панелі (NeedsReschedulePanel, AffectedPanel,
     CallListPanel, CancelledRow, RoomLoad) побудовані з AST цілком — разом з
     інлайновим style, який браузер ставить вище за будь-який селектор;
   • каскад: !important > інлайновий style > специфічність > порядок у джерелі;
     успадковані властивості (white-space, overflow-wrap) — від предків;
   • контексти — усі межі медіа-умов із файлів (b−1, b, b+1) × щільність ×
     тип вказівника × prefers-reduced-motion;
   • шорткати розгортаються (padding / margin / inset / scroll-padding з
     логічними варіантами, border*, overflow, overscroll-behavior, gap,
     white-space, grid / grid-template — і з іменованими областями,
     grid-area/-row/-column, логічні розміри, `all`), значення нормалізуються
     (`minmax(0,1fr)` = `minmax(0, 1fr)`). Логічні сторони — для
     horizontal-tb зліва направо (інтерфейс лише такий).
   Чого розбір не розуміє, про те ПАДАЄ з назвою, а не мовчить: селектор, що
   «може» взяти ціль (стан :hover, структурні псевдокласи, :has) і оголошує
   пінену властивість; медіа-ознака, одиниця (лише px) чи at-правило
   (@supports, @layer …), яких немає в розборі; розмітка, яку модель не вміє
   перенести (className чи style з виразом, JSX у пропсі, компонент між іменем
   і панеллю).

   Замір у Chromium (реальні файли CSS, скелети /queue, /radiologist та інших
   екранів) — у звітах с79; ці тести його НЕ замінюють, вони тримають правила
   від тихого повернення. */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/* Порядок — як у документі: /queue вантажить radflow.css → radflow-screens.css,
   /radiologist ще й radiologist.css. radflow-wizard.css імпортує лише SetupWizard,
   але Next не вивантажує CSS при клієнтському переході: після /setup → /queue він
   лишається в документі, причому ПІЗНІШЕ за стилі дошки — тому він тут останнім. */
const FILES = ["styles/prototype/radflow.css", "styles/prototype/radflow-screens.css", "styles/prototype/radiologist.css", "styles/prototype/radflow-wizard.css"];

/* Кільце фокуса проєкту: outline 2px + outline-offset 2px — виходить за елемент на 4px
   (`.rf-navtoggle:focus-visible`, `:focus-visible` кнопок і рядків). */
const RING = 4;

type Tri = 0 | 1 | 2; // ні / можливо / так
const AND = (a: Tri, b: Tri): Tri => (a === 0 || b === 0 ? 0 : a === 1 || b === 1 ? 1 : 2);
const OR = (a: Tri, b: Tri): Tri => (a === 2 || b === 2 ? 2 : a === 1 || b === 1 ? 1 : 0);
type Spec = [number, number, number];
const cmpSpec = (a: Spec, b: Spec) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const addSpec = (a: Spec, b: Spec): Spec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const maxSpec = (xs: Spec[]): Spec => xs.reduce((m, s) => (cmpSpec(s, m) > 0 ? s : m), [0, 0, 0] as Spec);

/* ---------- розбір CSS ---------- */

type Decl = { prop: string; value: string; important: boolean };
type Rule = { sels: Complex[]; selText: string; decls: Decl[]; media: string | null; order: number; file: string };

/** Ділить рядок за роздільником верхнього рівня (поза дужками й лапками). */
function splitTop(s: string, sep: (ch: string) => boolean): string[] {
  const out: string[] = [];
  let depth = 0, q: string | null = null, cur = "";
  for (const ch of s) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (depth === 0 && sep(ch)) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** Нормалізація значення: регістр, пробіли навколо ком і дужок. */
const canon = (v: string) => v.trim().toLowerCase().replace(/\s+/g, " ").replace(/\s*,\s*/g, ",").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");

function parseDecls(body: string): Decl[] {
  return splitTop(body, (c) => c === ";").map((d) => {
    const i = d.indexOf(":");
    if (i < 0) return null;
    const raw = d.slice(i + 1).trim();
    return { prop: d.slice(0, i).trim().toLowerCase(), value: raw.replace(/\s*!\s*important$/i, ""), important: /!\s*important$/i.test(raw) };
  }).filter((d): d is Decl => !!d && !!d.prop);
}

function parseCss(files: string[]): Rule[] {
  const rules: Rule[] = [];
  let order = 0;
  for (const file of files) {
    const src = read(file).replace(/\/\*[\s\S]*?\*\//g, "");
    if (src.includes("\\")) throw new Error(`${file}: екранування в CSS розбір не підтримує — розширте пін`);
    const close = (open: number) => {
      let d = 0;
      for (let j = open; j < src.length; j++) {
        if (src[j] === "{") d++;
        else if (src[j] === "}" && --d === 0) return j;
      }
      throw new Error(`${file}: незбалансовані дужки від позиції ${open}`);
    };
    const walk = (from: number, to: number, media: string | null) => {
      let k = from;
      for (;;) {
        const open = src.indexOf("{", k);
        if (open < 0 || open >= to) return;
        const prelude = src.slice(k, open).trim();
        const end = close(open);
        if (/^@media\b/.test(prelude)) {
          if (media) throw new Error(`${file}: вкладений @media — розширте розбір`);
          walk(open + 1, end, prelude.slice(6).trim());
        } else if (/^@(-webkit-)?keyframes\b/.test(prelude)) {
          // кадри анімацій — не правила елементів
        } else if (prelude.startsWith("@")) {
          throw new Error(`${file}: at-правило «${prelude.slice(0, 40)}» розбір не знає — розширте пін`);
        } else {
          const body = src.slice(open + 1, end);
          // CSS nesting (`.a { & > .b { … } }`, `.a { @media … { … } }`) Chromium застосовує —
          // а розбір, що бачить лише верхній рівень, пропустив би його мовчки.
          if (body.includes("{")) throw new Error(`${file}: у тілі «${prelude.replace(/\s+/g, " ").slice(0, 60)}» вкладене правило чи @-блок (CSS nesting) — розбір їх не рахує, розширте пін`);
          rules.push({ sels: splitTop(prelude, (c) => c === ",").map((s) => parseComplex(s.trim())), selText: prelude.replace(/\s+/g, " "), decls: parseDecls(body), media, order: order++, file });
        }
        k = end + 1;
      }
    };
    walk(0, src.length, null);
  }
  return rules;
}

/* ---------- селектори ---------- */

type Attr = { name: string; op: string | null; value: string; ci: boolean };
type Pseudo = { name: string; args: Complex[] | null; raw: string | null };
type Compound = { type: string | null; id: string | null; classes: string[]; attrs: Attr[]; pseudos: Pseudo[]; pseudoEl: boolean };
type Complex = { parts: { comb: string; c: Compound }[]; text: string; spec: Spec };

const IDENT = /^-?[_a-zA-Z -￿][-_a-zA-Z0-9 -￿]*/;
const LIST_PSEUDO = new Set(["not", "is", "where", "matches", "-webkit-any", "has"]);
const LEGACY_PSEUDO_EL = new Set(["before", "after", "first-line", "first-letter"]);

function parseCompound(s: string, whole: string): Compound {
  const c: Compound = { type: null, id: null, classes: [], attrs: [], pseudos: [], pseudoEl: false };
  let i = 0;
  const ident = () => { const m = s.slice(i).match(IDENT); if (!m) throw new Error(`селектор «${whole}»: не розібрано «${s.slice(i)}»`); i += m[0].length; return m[0]; };
  const group = (open: string, closeCh: string) => { // від open до відповідної закривної, з урахуванням вкладеності
    let d = 0, q: string | null = null;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (q) { if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'") { q = ch; continue; }
      if (ch === open) d++;
      else if (ch === closeCh && --d === 0) { const inner = s.slice(i + 1, j); i = j + 1; return inner; }
    }
    throw new Error(`селектор «${whole}»: незакрита «${open}»`);
  };
  if (s[i] === "*") { c.type = "*"; i++; } else if (IDENT.test(s)) c.type = ident().toLowerCase();
  while (i < s.length) {
    const ch = s[i];
    if (ch === ".") { i++; c.classes.push(ident()); }
    else if (ch === "#") { i++; c.id = ident(); }
    else if (ch === "[") {
      const inner = group("[", "]").trim();
      const m = inner.match(/^([-\w]+)\s*(?:([~|^$*]?=)\s*("([^"]*)"|'([^']*)'|[^\s\]]+)\s*([is])?)?$/i);
      if (!m) throw new Error(`селектор «${whole}»: атрибут «${inner}» не розібрано`);
      c.attrs.push({ name: m[1].toLowerCase(), op: m[2] || null, value: m[4] ?? m[5] ?? m[3] ?? "", ci: (m[6] || "").toLowerCase() === "i" });
    } else if (ch === ":") {
      const el = s[i + 1] === ":";
      i += el ? 2 : 1;
      const name = ident().toLowerCase();
      const args = s[i] === "(" ? group("(", ")") : null;
      if (el || LEGACY_PSEUDO_EL.has(name)) c.pseudoEl = true;
      else c.pseudos.push({ name, args: args !== null && LIST_PSEUDO.has(name) ? splitTop(args, (x) => x === ",").map((a) => parseComplex(a.trim())) : null, raw: args });
    } else throw new Error(`селектор «${whole}»: не розібрано «${s.slice(i)}»`);
  }
  return c;
}

function compoundSpec(c: Compound): Spec {
  let s: Spec = [c.id ? 1 : 0, c.classes.length + c.attrs.length, c.type && c.type !== "*" ? 1 : 0];
  if (c.pseudoEl) s = addSpec(s, [0, 0, 1]);
  for (const p of c.pseudos) {
    if (p.name === "where") continue;
    s = addSpec(s, p.args ? maxSpec(p.args.map((a) => a.spec)) : [0, 1, 0]);
  }
  return s;
}

function parseComplex(text: string): Complex {
  // Комбінатори — лише на верхньому рівні: `~=` в атрибуті й `2n+1` у :nth-child — усередині дужок.
  const parts: { comb: string; c: Compound }[] = [];
  let cur = "", pending: string | null = null, depth = 0, q: string | null = null;
  const flush = () => { if (!cur) return; parts.push({ comb: parts.length ? pending ?? " " : " ", c: parseCompound(cur, text) }); cur = ""; pending = null; };
  for (const ch of text) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (depth === 0 && /\s/.test(ch)) { if (cur) { flush(); pending = " "; } continue; }
    if (depth === 0 && (ch === ">" || ch === "+" || ch === "~")) { flush(); pending = ch; continue; }
    cur += ch;
  }
  flush();
  if (!parts.length) throw new Error(`порожній селектор у «${text}»`);
  return { parts, text, spec: parts.reduce((s, p) => addSpec(s, compoundSpec(p.c)), [0, 0, 0] as Spec) };
}

/* ---------- модель: елементи ---------- */

/** attrs: значення null — атрибут є, але значення не статичне (вираз у TSX).
    prevUnknown — попередніх сусідів модель не знає: `+`/`~` дають «можливо». */
type El = { uid: number; name: string; tag: string; id: string | null; cls: string[]; attrs: Record<string, string | null>; parent: El | null; prev: El[]; prevUnknown: boolean; inline: Decl[] };
type Density = "compact" | "comfortable" | "spacious";

let UID = 0;
const mk = (name: string, tag: string, cls: string[], attrs: Record<string, string | null>, parent: El | null, prev: El[], o: { id?: string; prevUnknown?: boolean; inline?: Decl[] } = {}): El =>
  ({ uid: UID++, name, tag, id: o.id ?? null, cls, attrs, parent, prev, prevUnknown: !!o.prevUnknown, inline: o.inline ?? [] });

function attrOf(el: El, name: string): string | null | undefined {
  if (name === "class") return el.cls.length ? el.cls.join(" ") : undefined;
  if (name === "id") return el.id ?? undefined;
  if (name === "style") return el.attrs.style ?? undefined;
  return el.attrs[name];
}

function matchAttr(a: Attr, el: El): Tri {
  let v = attrOf(el, a.name);
  if (v === undefined) return 0;
  if (!a.op) return 2;
  if (v === null) return 1;
  let w = a.value;
  if (a.ci) { v = v.toLowerCase(); w = w.toLowerCase(); }
  const ok = a.op === "=" ? v === w : a.op === "~=" ? v.split(/\s+/).includes(w) : a.op === "|=" ? v === w || v.startsWith(w + "-")
    : a.op === "^=" ? w !== "" && v.startsWith(w) : a.op === "$=" ? w !== "" && v.endsWith(w) : w !== "" && v.includes(w);
  return ok ? 2 : 0;
}

function matchCompound(c: Compound, el: El): Tri {
  if (c.pseudoEl) return 0;                                   // стилізує псевдоелемент, а не сам елемент
  if (c.type && c.type !== "*" && c.type !== el.tag) return 0;
  if (c.id && c.id !== el.id) return 0;
  for (const k of c.classes) if (!el.cls.includes(k)) return 0;
  let r: Tri = 2;
  for (const a of c.attrs) if ((r = AND(r, matchAttr(a, el))) === 0) return 0;
  for (const p of c.pseudos) {
    let t: Tri;
    if (p.name === "root") t = el.tag === "html" ? 2 : 0;
    else if (p.name === "not" && p.args) { const any = p.args.reduce<Tri>((m, a) => OR(m, matchComplex(a, el)), 0); t = any === 2 ? 0 : any === 0 ? 2 : 1; }
    else if (p.name === "has") t = 1;
    else if (p.args) t = p.args.reduce<Tri>((m, a) => OR(m, matchComplex(a, el)), 0);   // :is / :where / :matches
    else t = 1;                                               // стан (:hover, :focus…) чи структура (:first-child…) — «можливо»
    if ((r = AND(r, t)) === 0) return 0;
  }
  return r;
}

function matchComplex(x: Complex, el: El, idx = x.parts.length - 1): Tri {
  const here = matchCompound(x.parts[idx].c, el);
  if (here === 0 || idx === 0) return here;
  const comb = x.parts[idx].comb;
  let rest: Tri = 0;
  if (comb === ">") rest = el.parent ? matchComplex(x, el.parent, idx - 1) : 0;
  else if (comb === " ") for (let a = el.parent; a && rest !== 2; a = a.parent) rest = OR(rest, matchComplex(x, a, idx - 1));
  else if (comb === "+") rest = el.prev[0] ? matchComplex(x, el.prev[0], idx - 1) : el.prevUnknown ? 1 : 0;
  else { for (const s of el.prev) rest = OR(rest, matchComplex(x, s, idx - 1)); if (el.prevUnknown) rest = OR(rest, 1); } // "~"
  return AND(here, rest);
}

/* ---------- модель: TSX через AST ---------- */

type JEl = ts.JsxElement | ts.JsxSelfClosingElement;
type Kid = JEl | ts.JsxExpression | ts.JsxText;
const SF = new Map<string, ts.SourceFile>();
const sourceOf = (file: string) => SF.get(file) ?? SF.set(file, ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)).get(file)!;
const opening = (n: JEl) => (ts.isJsxElement(n) ? n.openingElement : n);
const tagOf = (n: JEl) => opening(n).tagName.getText();
const where = (n: ts.Node) => { const sf = n.getSourceFile(); return `${sf.fileName}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`; };

/** Статичне значення атрибута: undefined — атрибута немає; null — вираз. */
function attrValue(n: JEl, name: string): string | null | undefined {
  const a = opening(n).attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name);
  if (!a) return undefined;
  const init = a.initializer;
  if (!init) return "true";
  if (ts.isStringLiteral(init)) return init.text;
  if (ts.isJsxExpression(init) && init.expression && (ts.isStringLiteral(init.expression) || ts.isNoSubstitutionTemplateLiteral(init.expression))) return init.expression.text;
  return null;
}
const classesOf = (n: JEl): string[] | null => { const v = attrValue(n, "className"); return v === undefined ? [] : v === null ? null : v.split(/\s+/).filter(Boolean); };

function forEachJsx(root: ts.Node, fn: (n: JEl) => void) {
  const visit = (n: ts.Node) => { if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) fn(n); ts.forEachChild(n, visit); };
  visit(root);
}

/** Діти для DOM: фрагменти розгортаються, пробільний текст і порожні `{}` (коментарі) — ні. */
function kidsOf(n: JEl): Kid[] {
  if (!ts.isJsxElement(n)) return [];
  const out: Kid[] = [];
  const add = (cs: ts.NodeArray<ts.JsxChild>) => {
    for (const c of cs) {
      if (ts.isJsxText(c)) { if (c.text.trim()) out.push(c); }
      else if (ts.isJsxExpression(c)) { if (c.expression) out.push(c); }
      else if (ts.isJsxFragment(c)) add(c.children);
      else out.push(c);
    }
  };
  add(n.children);
  return out;
}
const descOf = (k: Kid): string => {
  if (ts.isJsxText(k)) return "текст";
  if (ts.isJsxExpression(k)) return "{вираз}";
  const cls = classesOf(k);
  return tagOf(k) + (cls === null ? ".{вираз}" : cls.map((c) => "." + c).join(""));
};

/* React пише числа з px, крім безрозмірних властивостей. */
const UNITLESS = new Set(["animationIterationCount", "aspectRatio", "columnCount", "flex", "flexGrow", "flexShrink", "fontWeight", "gridArea", "gridColumn", "gridColumnEnd", "gridColumnStart", "gridRow", "gridRowEnd", "gridRowStart", "lineClamp", "lineHeight", "opacity", "order", "orphans", "scale", "tabSize", "widows", "zIndex", "zoom"]);
const kebab = (k: string) => (k.startsWith("--") ? k : k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase()));

/** Інлайновий style з AST: пари [css-властивість, значення]; вираз у значенні — падіння з назвою. */
function inlineStyleOf(n: JEl): [string, string][] {
  const a = opening(n).attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === "style");
  if (!a) return [];
  const e = a.initializer && ts.isJsxExpression(a.initializer) ? a.initializer.expression : undefined;
  if (!e || !ts.isObjectLiteralExpression(e)) throw new Error(`${where(n)}: style не літерал-обʼєкт — модель його не рахує, розширте пін`);
  return e.properties.map((p) => {
    if (!ts.isPropertyAssignment(p)) throw new Error(`${where(p)}: у style не пара «ключ: значення» — розширте пін`);
    const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null;
    const v = p.initializer;
    const val = ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v) ? v.text
      : ts.isNumericLiteral(v) ? (Number(v.text) === 0 || UNITLESS.has(key ?? "") ? v.text : `${v.text}px`) : null;
    if (key === null || val === null) throw new Error(`${where(p)}: у style вираз «${p.getText().slice(0, 50)}» — модель його не рахує, розширте пін`);
    return [kebab(key), val] as [string, string];
  });
}

/* Атрибути DOM з пропсів React (для селекторів атрибутів). */
const SKIP_PROPS = new Set(["key", "ref", "children", "className", "style", "dangerouslySetInnerHTML", "suppressHydrationWarning"]);
const PROP_ATTR: Record<string, string> = { htmlFor: "for", tabIndex: "tabindex", readOnly: "readonly", autoComplete: "autocomplete" };
function domAttrsOf(n: JEl): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const p of opening(n).attributes.properties) {
    if (ts.isJsxSpreadAttribute(p)) throw new Error(`${where(n)}: {...spread} у пропсах — модель не знає атрибутів, розширте пін`);
    const name = p.name.getText();
    if (SKIP_PROPS.has(name) || /^on[A-Z]/.test(name)) continue;
    out[PROP_ATTR[name] ?? name] = attrValue(n, name) ?? null;
  }
  return out;
}

const boundaryOf = (n: ts.Node): string | null => {
  if (ts.isFunctionDeclaration(n) && n.name) return n.name.text;
  if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) return n.name.text;
  return null;
};
/* Між JSX-елементом і його DOM-батьком дозволені лише «прозорі» вузли: `{…}`, дужки, `?:`,
   `&&`, колбек `.map(…)`, return. JSX у змінній, у пропсі чи аргументом функції (портал!)
   рендериться деінде — такий шлях позначається непрозорим. */
const PASS = new Set([ts.SyntaxKind.JsxExpression, ts.SyntaxKind.ParenthesizedExpression, ts.SyntaxKind.ConditionalExpression, ts.SyntaxKind.BinaryExpression, ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.FunctionExpression, ts.SyntaxKind.ReturnStatement, ts.SyntaxKind.Block, ts.SyntaxKind.IfStatement, ts.SyntaxKind.ArrayLiteralExpression, ts.SyntaxKind.AsExpression,
  ts.SyntaxKind.NonNullExpression, ts.SyntaxKind.SatisfiesExpression, ts.SyntaxKind.JsxFragment]);
/** Найближчий JSX-предок у DOM або межа компонента; note — чому шлях непрозорий. */
function jsxUp(n: ts.Node): { el: JEl; note: string | null } | { boundary: string; note: string | null } | null {
  let note: string | null = null, prev: ts.Node = n;
  for (let p = n.parent; p; prev = p, p = p.parent) {
    if (ts.isJsxElement(p)) return { el: p, note };
    if (ts.isJsxSelfClosingElement(p)) return { el: p, note: note ?? "JSX у пропсі" };
    if (ts.isJsxAttribute(p)) { note ??= `JSX у пропсі ${p.name.getText()}`; continue; }
    if (ts.isJsxAttributes(p) || ts.isJsxOpeningElement(p)) continue;
    const b = boundaryOf(p);
    if (b) return { boundary: b, note };
    if (ts.isCallExpression(p) && (ts.isArrowFunction(prev) || ts.isFunctionExpression(prev))) continue;   // колбек .map(…)
    if (!PASS.has(p.kind)) note ??= `JSX у ${ts.SyntaxKind[p.kind]}`;
  }
  return null;
}
const usagesOf = (sf: ts.SourceFile, comp: string): JEl[] => { const out: JEl[] = []; forEachJsx(sf, (n) => { if (tagOf(n) === comp) out.push(n); }); return out; };

/** Шляхи від елемента вгору до aside.rpanel (без неї) — крізь межі компонентів до місць їх
    виклику. Шлях, що йде повз панель, просто відкидається; непрозорий шлях (компонент між
    елементом і панеллю, JSX у змінній/пропсі), що ДОХОДИТЬ до панелі, — падіння з назвою. */
function chainsToPanel(sf: ts.SourceFile, start: JEl): JEl[][] {
  const out: JEl[][] = [];
  const go = (from: ts.Node, acc: JEl[], seen: string[], opaque: string | null) => {
    const up = jsxUp(from);
    if (!up) return;                                          // корінь файла — поза панеллю
    const op = opaque ?? up.note;
    if ("boundary" in up) {
      if (seen.includes(up.boundary)) return;
      for (const u of usagesOf(sf, up.boundary)) go(u, acc, [...seen, up.boundary], op);
      return;
    }
    const tag = tagOf(up.el);
    if (tag === "aside" && (classesOf(up.el) ?? []).includes("rpanel")) {
      if (op) throw new Error(`${where(start)}: на шляху до панелі ${op} — модель не знає, де воно в DOM, розширте пін`);
      out.push(acc);
      return;
    }
    go(up.el, [...acc, up.el], seen, op ?? (/^[a-z]/.test(tag) ? null : `компонент <${tag}>`));
  };
  go(start, [start], [], null);
  return out;
}
const enclosingFn = (n: ts.Node): string => { for (let p: ts.Node | undefined = n; p; p = p.parent) { const b = boundaryOf(p); if (b) return b; } return "?"; };

type ElTpl = { tag: string; cls: string[]; attrs: Record<string, string | null>; style: [string, string][] };
type NameChain = { key: string; what: string; tpl: ElTpl[] };   // tpl[0] — сам елемент з іменем, останній — дитина aside.rpanel

/* Два записи атрибута style, як їх бачать селектори: розмітка сервера (React SSR) і
   серіалізація CSSOM, коли елемент створено на клієнті — `[style*=…]` мусить брати обидва. */
const STYLE_FORMS: Record<string, (s: [string, string][]) => string> = {
  ssr: (s) => s.map(([k, v]) => `${k}:${v}`).join(";"),
  cssom: (s) => s.map(([k, v]) => `${k}: ${v};`).join(" "),
};

/** Імена пацієнтів (`{….patient_name}` у span) і назви кабінетів (span.load-name), що
    рендеряться всередині aside.rpanel дошки черги. */
function panelNameChains(): { chains: NameChain[]; comps: Set<string> } {
  const sf = sourceOf("components/QueueBoard.tsx");
  const starts: JEl[] = [];
  forEachJsx(sf, (n) => {
    if (tagOf(n) !== "span") return;
    const isName = kidsOf(n).some((k) => ts.isJsxExpression(k) && !!k.expression && /\.patient_name$/.test(k.expression.getText()));
    if (isName || (classesOf(n) ?? []).includes("load-name")) starts.push(n);
  });
  const chains: NameChain[] = [], comps = new Set<string>();
  for (const s of starts) {
    for (const path of chainsToPanel(sf, s)) {
      const comp = enclosingFn(s);
      comps.add(comp);
      const tpl = path.map((n): ElTpl => {
        const cls = classesOf(n);
        if (cls === null) throw new Error(`${where(n)}: className — вираз; модель не знає класів, розширте пін`);
        return { tag: tagOf(n), cls, attrs: domAttrsOf(n), style: inlineStyleOf(n) };
      });
      for (const form of Object.keys(STYLE_FORMS)) chains.push({ key: `name#${chains.length}`, what: `${comp} (${where(s)}, style як ${form})`, tpl: tpl.map((t) => ({ ...t, attrs: t.style.length ? { ...t.attrs, style: STYLE_FORMS[form](t.style) } : t.attrs })) });
    }
  }
  return { chains, comps };
}

/* ---------- модель оболонки (див. тест «модель звірена з TSX») ---------- */

function shell(density: Density) {
  const html = mk("html", "html", [], { lang: "uk", "data-density": density }, null, []);
  const head = mk("head", "head", [], {}, html, []);
  const body = mk("body", "body", [], {}, html, [head]);
  const script = mk("script", "script", [], {}, body, []);
  const app = mk(".app", "div", ["app"], {}, body, [script]);
  const nav = mk("«☰»", "button", ["rf-navtoggle"], { type: "button", "aria-label": null, "aria-expanded": null, "aria-controls": "rf-nav" }, app, []);
  const scrim = mk(".rf-nav-scrim", "div", ["rf-nav-scrim"], { "aria-hidden": "true" }, app, [nav]);
  const sidebar = mk(".sidebar", "aside", ["sidebar"], {}, app, [scrim, nav], { id: "rf-nav" });
  const navclose = mk(".rf-navclose", "button", ["rf-navclose"], { type: "button", "aria-label": "Закрити меню" }, sidebar, []);
  const sbNav = mk(".sb-nav", "nav", ["sb-nav"], {}, sidebar, [navclose], { prevUnknown: true });
  const main = mk(".main", "div", ["main"], {}, app, [sidebar, scrim, nav]);
  const topbar = mk(".topbar", "header", ["topbar"], {}, main, []);
  const tbTitle = mk(".tb-title", "div", ["tb-title"], {}, topbar, []);
  const wrap = mk(".content-wrap", "div", ["content-wrap"], {}, main, [topbar]);
  const content = mk(".content", "div", ["content"], {}, wrap, []);
  const rpanel = mk(".rpanel", "aside", ["rpanel"], {}, wrap, [content]);
  // екрани-списки (/calls, /journal, /waitlist, /services, /search): .main > header.topbar + div.content-full
  const main2 = mk(".main", "div", ["main"], {}, app, [sidebar, scrim, nav]);
  const topbar2 = mk(".topbar", "header", ["topbar"], {}, main2, []);
  const contentFull = mk(".content-full", "div", ["content-full"], {}, main2, [topbar2], { prevUnknown: true });
  return { "content-wrap": wrap, content, rpanel, topbar, "tb-title": tbTitle, "rf-navtoggle": nav, "sb-nav": sbNav, "content-full": contentFull } as Record<string, El>;
}

/** Ланцюжки з AST — під .rpanel оболонки; ціль — елемент з іменем. */
function attachChains(sh: Record<string, El>, chains: NameChain[]) {
  for (const n of chains) {
    let parent = sh.rpanel;
    for (let i = n.tpl.length - 1; i >= 0; i--) {
      const t = n.tpl[i];
      parent = mk(i === 0 ? n.what : `${t.tag}${t.cls.map((c) => "." + c).join("")}`, t.tag, t.cls, t.attrs, parent, [], { prevUnknown: true, inline: t.style.map(([prop, value]) => ({ prop, value, important: false })) });
    }
    sh[n.key] = parent;
  }
}

/* ---------- медіа-умови ---------- */

type Ctx = { w: number; density: Density; coarse: boolean; reduce: boolean };

const px = (v: string, media: string): number => {
  const m = v.trim().match(/^(\d+(?:\.\d+)?)px$/);
  if (!m) throw new Error(`медіа «${media}»: «${v}» — у медіа-умовах пін розуміє лише px`);
  return parseFloat(m[1]);
};
const CMP: Record<string, (a: number, b: number) => boolean> = { "<": (a, b) => a < b, "<=": (a, b) => a <= b, ">": (a, b) => a > b, ">=": (a, b) => a >= b, "=": (a, b) => a === b };
const FLIP: Record<string, string> = { "<": ">", "<=": ">=", ">": "<", ">=": "<=", "=": "=" };

function featureApplies(f: string, ctx: Ctx, media: string): boolean {
  const inner = f.trim().replace(/^\(\s*|\s*\)$/g, "");
  let m = inner.match(/^(max|min)-width\s*:\s*(.+)$/);
  if (m) return m[1] === "max" ? ctx.w <= px(m[2], media) : ctx.w >= px(m[2], media);
  m = inner.match(/^width\s*(<=|>=|<|>|=)\s*(\S+)$/);                       // (width <= 1240px)
  if (m) return CMP[m[1]](ctx.w, px(m[2], media));
  m = inner.match(/^(\S+)\s*(<=|>=|<|>|=)\s*width$/);                       // (1240px >= width)
  if (m) return CMP[FLIP[m[2]]](ctx.w, px(m[1], media));
  m = inner.match(/^(\S+)\s*(<=|<)\s*width\s*(<=|<)\s*(\S+)$/);             // (481px <= width <= 1240px)
  if (m) return CMP[FLIP[m[2]]](ctx.w, px(m[1], media)) && CMP[m[3]](ctx.w, px(m[4], media));
  m = inner.match(/^(\S+)\s*(>=|>)\s*width\s*(>=|>)\s*(\S+)$/);
  if (m) return CMP[FLIP[m[2]]](ctx.w, px(m[1], media)) && CMP[m[3]](ctx.w, px(m[4], media));
  m = inner.match(/^(any-)?pointer\s*:\s*(coarse|fine|none)$/);
  if (m) return (m[2] === "coarse") === ctx.coarse && m[2] !== "none";
  m = inner.match(/^(any-)?hover\s*:\s*(hover|none)$/);
  if (m) return (m[2] === "none") === ctx.coarse;
  m = inner.match(/^prefers-reduced-motion\s*:\s*(reduce|no-preference)$/);
  if (m) return (m[1] === "reduce") === ctx.reduce;
  throw new Error(`медіа «${media}»: ознаку «${f.trim()}» пін не розуміє — розширте розбір`);
}

function mediaApplies(media: string | null, ctx: Ctx): boolean {
  if (!media) return true;
  return splitTop(media, (c) => c === ",").some((q) => {
    const parts = q.trim().split(/\s+and\s+/i).map((p) => p.trim()).filter(Boolean);
    return parts.every((p) => {
      if (/^(only\s+)?(screen|all)$/i.test(p)) return true;
      if (/^(only\s+)?print$/i.test(p)) return false;
      if (!p.startsWith("(")) throw new Error(`медіа «${media}»: «${p}» пін не розуміє (not / тип носія) — розширте розбір`);
      return featureApplies(p, ctx, media);
    });
  });
}

/** Межі з усіх медіа-умов у px: b−1, b, b+1 — між сусідніми межами умови сталі. */
function widthsFrom(rules: Rule[]): number[] {
  const ws = new Set([1920, 1600, 1440, 1366, 1280, 1024, 800, 768, 600, 375, 320]);
  for (const r of rules) for (const m of (r.media || "").matchAll(/(\d+(?:\.\d+)?)px/g)) { const b = Math.round(parseFloat(m[1])); for (const d of [-1, 0, 1]) if (b + d >= 280) ws.add(b + d); }
  return [...ws].sort((a, b) => b - a);
}

/* ---------- властивості: шорткати → довгі ---------- */

const SIDES = ["top", "right", "bottom", "left"] as const;
const BORDER_STYLES = new Set(["none", "hidden", "solid", "dashed", "dotted", "double", "groove", "ridge", "inset", "outset"]);
const words = (v: string) => splitTop(canon(v), (c) => c === " ").filter(Boolean);
const fourSides = (v: string): string[] => { const [t, r = t, b = t, l = r] = words(v); return [t, r, b, l]; };
const twoSides = (v: string): [string, string] => { const p = words(v); return [p[0], p[1] ?? p[0]]; };

function borderParts(v: string): { width: string; style: string; color: string } {
  let width = "medium", style = "none"; const color: string[] = [];
  for (const t of words(v)) {
    if (/^(\d*\.?\d+(px|rem|em)?|thin|medium|thick)$/.test(t)) width = t;
    else if (BORDER_STYLES.has(t)) style = t;
    else color.push(t);
  }
  return { width, style, color: color.length ? color.join(" ") : "currentcolor" };
}

/* Сімейства «коробки»: шорткат, -block/-inline і їхні -start/-end → фізичні сторони. */
const BOX: Record<string, (side: string) => string> = { padding: (s) => `padding-${s}`, margin: (s) => `margin-${s}`, "scroll-padding": (s) => `scroll-padding-${s}`, inset: (s) => s };
const LOGICAL: Record<string, string[]> = { block: ["top", "bottom"], inline: ["left", "right"], "block-start": ["top"], "block-end": ["bottom"], "inline-start": ["left"], "inline-end": ["right"] };
const ALIAS: Record<string, string> = { "word-wrap": "overflow-wrap", "grid-gap": "gap", "grid-row-gap": "row-gap", "grid-column-gap": "column-gap", "-webkit-transform": "transform" };
const WIDE = new Set(["inherit", "initial", "unset", "revert", "revert-layer"]);   // CSS-wide: іде в усі довгі як є
/* white-space — шорткат (CSS Text 4) над white-space-collapse і text-wrap-mode. */
const WHITE_SPACE: Record<string, [string, string]> = { normal: ["collapse", "wrap"], nowrap: ["collapse", "nowrap"], pre: ["preserve", "nowrap"], "pre-wrap": ["preserve", "wrap"], "pre-line": ["preserve-breaks", "wrap"], "break-spaces": ["break-spaces", "wrap"] };

/** Список треків без імен ліній (`[a] 1fr [b]` = `1fr`: імена розмір не змінюють). */
const tracks = (x: string) => canon(x.replace(/\[[^\]]*\]/g, " "));

/** grid / grid-template: `rows / columns` і форма з рядками областей (`"a" 1fr "b" auto / 1fr`). */
function gridTemplate(prop: string, value: string): [string, string][] {
  const v = canon(value);
  const mark: [string, string][] = [["grid-template-rows", `${prop}:${v}`], ["grid-template-columns", `${prop}:${v}`]];
  if (v === "none") return [["grid-template-rows", "none"], ["grid-template-columns", "none"], ["grid-template-areas", "none"]];
  if (/auto-flow/.test(v)) return mark;
  const halves = splitTop(value, (c) => c === "/");
  if (halves.length !== 2) return mark;
  const [rowsPart, colsPart] = halves;
  if (!/["']/.test(rowsPart)) return [["grid-template-rows", tracks(rowsPart)], ["grid-template-columns", tracks(colsPart)]];
  const rows: string[] = [], areas: string[] = [];
  for (const t of splitTop(rowsPart.trim(), (c) => /\s/.test(c)).filter(Boolean)) {
    if (/^["']/.test(t)) { areas.push(t); rows.push("auto"); }
    else if (t.startsWith("[")) continue;                     // імена ліній розмір не змінюють
    else if (rows.length && rows[rows.length - 1] === "auto" && areas.length === rows.length) rows[rows.length - 1] = canon(t);
    else return mark;
  }
  return [["grid-template-rows", rows.join(" ")], ["grid-template-columns", tracks(colsPart)], ["grid-template-areas", areas.join(" ")]];
}

/** Довгі властивості, які ставить декларація. Значення — нормалізовані. */
function longhands(prop0: string, value: string): [string, string][] {
  const prop = ALIAS[prop0] ?? prop0;
  const v = canon(value);
  for (const [base, side] of Object.entries(BOX)) {
    if (prop === base) return fourSides(value).map((x, i) => [side(SIDES[i]), x]);
    if (prop.startsWith(base + "-")) {
      const rest = prop.slice(base.length + 1), ss = LOGICAL[rest];
      if (ss) { const vals = ss.length === 2 ? twoSides(value) : [v]; return ss.map((s, i) => [side(s), vals[i]]); }
    }
  }
  switch (prop) {
    case "overflow": { const [x, y] = twoSides(value); return [["overflow-x", x], ["overflow-y", y]]; }
    case "overflow-block": return [["overflow-y", v]];
    case "overflow-inline": return [["overflow-x", v]];
    case "overscroll-behavior": { const [x, y] = twoSides(value); return [["overscroll-behavior-x", x], ["overscroll-behavior-y", y]]; }
    case "overscroll-behavior-block": return [["overscroll-behavior-y", v]];
    case "overscroll-behavior-inline": return [["overscroll-behavior-x", v]];
    case "block-size": return [["height", v]];
    case "min-block-size": return [["min-height", v]];
    case "max-block-size": return [["max-height", v]];
    case "inline-size": return [["width", v]];
    case "min-inline-size": return [["min-width", v]];
    case "max-inline-size": return [["max-width", v]];
    case "gap": { const [r, c] = twoSides(value); return [["row-gap", r], ["column-gap", c]]; }
    case "white-space": { const ws = WIDE.has(v) ? [v, v] : WHITE_SPACE[v]; return ws ? [["white-space-collapse", ws[0]], ["text-wrap-mode", ws[1]]] : [["white-space-collapse", `white-space:${v}`], ["text-wrap-mode", `white-space:${v}`]]; }
    case "text-wrap": return [["text-wrap-mode", words(value).includes("nowrap") ? "nowrap" : "wrap"]];
    case "offset": return [["offset-path", v]];
    case "grid-area": { const p = splitTop(value, (c) => c === "/").map(canon); return [["grid-row-start", p[0]], ["grid-column-start", p[1] ?? "auto"], ["grid-row-end", p[2] ?? "auto"], ["grid-column-end", p[3] ?? "auto"]]; }
    case "grid-row": { const p = splitTop(value, (c) => c === "/").map(canon); return [["grid-row-start", p[0]], ["grid-row-end", p[1] ?? "auto"]]; }
    case "grid-column": { const p = splitTop(value, (c) => c === "/").map(canon); return [["grid-column-start", p[0]], ["grid-column-end", p[1] ?? "auto"]]; }
    case "grid":
    case "grid-template": return gridTemplate(prop, value);
    case "grid-template-rows":
    case "grid-template-columns": return [[prop, tracks(value)]];
    case "border": { const b = borderParts(value); return SIDES.flatMap((s) => [[`border-${s}-width`, b.width], [`border-${s}-style`, b.style], [`border-${s}-color`, b.color]] as [string, string][]); }
    case "border-width": return fourSides(value).map((x, i) => [`border-${SIDES[i]}-width`, x]);
    case "border-style": return fourSides(value).map((x, i) => [`border-${SIDES[i]}-style`, x]);
    case "border-color": return fourSides(value).map((x, i) => [`border-${SIDES[i]}-color`, x]);
    default: {
      // border-top, border-left-width, border-block-start, border-inline …
      const m = prop.match(/^border-(top|right|bottom|left|block|block-start|block-end|inline|inline-start|inline-end)(?:-(width|style|color))?$/);
      if (m) {
        const ss = LOGICAL[m[1]] || [m[1]];
        if (m[2]) return ss.map((s) => [`border-${s}-${m[2]}`, v] as [string, string]);
        const b = borderParts(value);
        return ss.flatMap((s) => [[`border-${s}-width`, b.width], [`border-${s}-style`, b.style], [`border-${s}-color`, b.color]] as [string, string][]);
      }
      return [[prop, v]];
    }
  }
}

/* ---------- каскад ---------- */

/* Панелі оболонки не мають власного місця в сітці, висоти чи зсуву: будь-що з цього
   переставляє рядки (order: -1 кладе панель у рядок 1fr), піднімає мінімум треку
   fit-content (min-height), зсуває панель поверх списку (inset, transform/translate,
   від'ємний margin, offset-path, zoom) або ховає її вміст (visibility,
   content-visibility, clip-path). Нейтральні значення (margin 0, transform none …)
   дозволені. */
const MUST_BE_UNSET = ["order", "grid-row-start", "grid-row-end", "grid-column-start", "grid-column-end", "height", "min-height", "top", "right", "bottom", "left", "visibility",
  "transform", "translate", "scale", "rotate", "zoom", "margin-top", "margin-right", "margin-bottom", "margin-left", "offset-path", "content-visibility", "clip-path"];
const NEUTRAL: Record<string, string[]> = {
  "margin-top": ["0", "0px"], "margin-right": ["0", "0px"], "margin-bottom": ["0", "0px"], "margin-left": ["0", "0px"],
  transform: ["none"], translate: ["none"], scale: ["none"], rotate: ["none"], zoom: ["1", "normal", "100%"], "offset-path": ["none"], "content-visibility": ["visible"], "clip-path": ["none"],
};
const unsetOk = (p: string, x: string | undefined) => x === undefined || (NEUTRAL[p] ?? []).includes(x);

/** Усе, що питають піни (щоб `all: …` розгорнути саме на них). */
const PINNED = ["display", "flex-direction", "position", "visibility", "order", "width", "height", "min-width", "min-height", "max-height", "left", "top", "right", "bottom",
  "overflow-x", "overflow-y", "overscroll-behavior-y", "grid-template-columns", "grid-template-rows", "grid-row-start", "grid-row-end", "grid-column-start", "grid-column-end",
  "row-gap", "column-gap", "transform", "translate", "scale", "rotate", "zoom", "offset-path", "content-visibility", "clip-path", "white-space-collapse", "text-wrap-mode", "overflow-wrap",
  ...SIDES.flatMap((s) => [`padding-${s}`, `margin-${s}`, `scroll-padding-${s}`, ...["width", "style", "color"].map((k) => `border-${s}-${k}`)])];

/* Успадковані з пінених: без оголошення значення береться від предка, у корені — початкове. */
const INHERITED: Record<string, string> = { "white-space-collapse": "collapse", "text-wrap-mode": "wrap", "overflow-wrap": "normal" };

type Entry = { rule: Rule; value: string; important: boolean };

function buildModel() {
  const rules = parseCss(FILES);
  const byProp = new Map<string, Entry[]>();
  const expand = (d: Decl): [string, string][] => (d.prop === "all" ? PINNED.map((p) => [p, `all:${canon(d.value)}`] as [string, string]) : longhands(d.prop, d.value));
  for (const rule of rules) for (const d of rule.decls) for (const [p, v] of expand(d)) (byProp.get(p) ?? byProp.set(p, []).get(p)!).push({ rule, value: v, important: d.important });
  const shells = { compact: shell("compact"), comfortable: shell("comfortable"), spacious: shell("spacious") } as Record<Density, Record<string, El>>;
  /* Ланцюжки імен із AST — окремо й ліниво: прогалина моделі TSX червонить лише тест імен,
     а не всі піни CSS. */
  let names: ReturnType<typeof panelNameChains> | null = null;
  const nameTargets = () => {
    if (!names) {
      const found = panelNameChains();
      for (const d of Object.keys(shells) as Density[]) attachChains(shells[d], found.chains);
      names = found;
    }
    return names;
  };
  const matchMemo = new Map<string, { tri: Tri; spec: Spec }>();
  const matchRule = (rule: Rule, el: El) => {
    const key = `${rule.order}|${el.uid}`;
    let m = matchMemo.get(key);
    if (!m) {
      let tri: Tri = 0, spec: Spec = [0, 0, 0];
      for (const s of rule.sels) {
        const t = matchComplex(s, el);
        if (t === 0) continue;
        if (t === 1 && tri !== 2) { tri = 1; if (cmpSpec(s.spec, spec) > 0) spec = s.spec; }
        if (t === 2) { if (tri !== 2 || cmpSpec(s.spec, spec) > 0) spec = s.spec; tri = 2; }
      }
      m = { tri, spec };
      matchMemo.set(key, m);
    }
    return m;
  };
  const mediaMemo = new Map<string, boolean>();
  const mediaOk = (media: string | null, c: Ctx) => { const k = `${media}|${c.w}|${c.coarse}|${c.reduce}`; let r = mediaMemo.get(k); if (r === undefined) mediaMemo.set(k, (r = mediaApplies(media, c))); return r; };
  /** Переможець каскаду: !important > інлайн > специфічність > пізніша декларація (обхід — у порядку джерела). */
  const cascaded = (el: El, prop: string, ctx: Ctx): string | undefined => {
    let best: { spec: Spec; value: string; important: boolean } | undefined;
    for (const e of byProp.get(prop) || []) {
      const m = matchRule(e.rule, el);
      if (m.tri === 0) continue;
      if (!mediaOk(e.rule.media, ctx)) continue;
      if (m.tri === 1) throw new Error(`${e.rule.file}: «${e.rule.selText}» може брати ${el.name} (стан/структура/сусіди) і оголошує ${prop} — розширте пін`);
      if (!best || (e.important && !best.important) || (e.important === best.important && cmpSpec(m.spec, best.spec) >= 0)) best = { spec: m.spec, value: e.value, important: e.important };
    }
    let inline: string | undefined;
    for (const d of el.inline) for (const [p, v] of longhands(d.prop, d.value)) if (p === prop) inline = v;
    if (inline !== undefined && !best?.important) return inline;
    return best?.value;
  };
  const computed = (target: string, prop: string, ctx: Ctx) => cascaded(shells[ctx.density][target], prop, ctx);
  /** Для успадкованих властивостей: перше оголошене значення вгору по предках. */
  const inherited = (target: string, prop: string, ctx: Ctx): string => {
    for (let el: El | null = shells[ctx.density][target]; el; el = el.parent) {
      const x = cascaded(el, prop, ctx);
      if (x === undefined || x === "inherit" || x === "unset" || x === "revert" || x === "revert-layer" || x === "all:inherit" || x === "all:unset" || x === "all:revert" || x === "all:revert-layer") continue;
      return x === "initial" || x === "all:initial" ? INHERITED[prop] : x;
    }
    return INHERITED[prop];
  };
  const contexts: Ctx[] = [];
  for (const w of widthsFrom(rules)) for (const density of ["compact", "comfortable", "spacious"] as Density[]) for (const coarse of [false, true]) for (const reduce of [false, true]) contexts.push({ w, density, coarse, reduce });
  return { rules, computed, inherited, contexts, nameTargets };
}

let MODEL: ReturnType<typeof buildModel> | null = null;
const model = () => (MODEL ??= buildModel());               // розбір — усередині тестів: збій розбору червонить з назвою тесту
const label = (c: Ctx) => `${c.w}px/${c.density}${c.coarse ? "/дотик" : ""}${c.reduce ? "/reduce" : ""}`;
const toPx = (v: string | undefined, root: number): number => {
  const m = (v ?? "").match(/^(-?\d*\.?\d+)(px|rem)$/);
  if (m) return parseFloat(m[1]) * (m[2] === "rem" ? root : 1);
  if (v === "0") return 0;
  throw new Error(`значення «${v}» пін не переводить у px (лише px/rem)`);
};

describe("с79 — права панель на планшеті (Н-11), відступи шапки (Н-12, Н-13), ревʼю р2", () => {
  it("Н-11: на ≤1240 px .rpanel — другий рядок під списком (не прихована, не переставлена, не зсунута), .content-wrap — сітка `1fr fit-content(40%)`, панель не вища 40dvh", () => {
    const { computed, contexts } = model();
    const bad: string[] = [];
    for (const c of contexts.filter((x) => x.w <= 1240)) {
      const v = (t: string, p: string) => computed(t, p, c);
      const want = (t: string, p: string, ok: (x: string | undefined) => boolean, what: string) => { const x = v(t, p); if (!ok(x)) bad.push(`${label(c)}: .${t} ${p} = ${x} (${what})`); };
      want("content-wrap", "display", (x) => x === "grid", "grid");
      want("content-wrap", "grid-template-columns", (x) => x === "minmax(0,1fr)", "minmax(0, 1fr)");
      // список — 1fr (= minmax(auto, 1fr)): рядок не стискається нижче підлоги самого списку, і панель
      // не малюється поверх нього (ревʼю с79-р1); панель — за вмістом, стеля рівно 40%
      want("content-wrap", "grid-template-rows", (x) => x === "1fr fit-content(40%)", "1fr fit-content(40%)");
      want("content-wrap", "overflow-y", (x) => x === "hidden", "hidden — у крайніх випадках панель обрізається, а не розпирає сторінку");
      want("rpanel", "display", (x) => x === "grid", "grid — другий рядок, не display:none і не програш базовому flex");
      want("rpanel", "grid-template-columns", (x) => /^repeat\(auto-fill,minmax\(min\(100%,\d+(\.\d+)?rem\),1fr\)\)$/.test(x ?? ""), "секції колонками, min(100%, …) — без переповнення");
      want("rpanel", "max-height", (x) => x === "40dvh", "40dvh — страховка WebKit");
      want("rpanel", "border-left-style", (x) => x === "none" || x === "hidden" || v("rpanel", "border-left-width") === "0", "межі зліва немає");
      want("rpanel", "border-top-width", (x) => x === "1px", "розділювач зверху");
      want("rpanel", "border-top-style", (x) => x === "solid", "розділювач зверху");
      want("rpanel", "border-top-color", (x) => x === "var(--border)", "розділювач зверху");
      // с78: обидві панелі прокрутки — containing block і не передають прокрутку сторінці
      for (const t of ["rpanel", "content"]) {
        want(t, "position", (x) => x === "relative", "relative (с78)");
        want(t, "overscroll-behavior-y", (x) => x === "contain", "contain (с78)");
        want(t, "overflow-y", (x) => x === "auto", "auto — панель прокручується сама");
        for (const p of MUST_BE_UNSET) want(t, p, (x) => unsetOk(p, x), "не оголошується (чи нейтральне)");
      }
      want("content", "max-height", (x) => x === undefined, "не оголошується");
    }
    expect(bad).toEqual([]);
  });

  it("Н-11: на >1240 px розкладка та сама, що до с79 — панель праворуч 320 px, flex-стовпець із лівою межею", () => {
    const { computed, contexts } = model();
    const bad: string[] = [];
    for (const c of contexts.filter((x) => x.w > 1240)) {
      const v = (t: string, p: string) => computed(t, p, c);
      const want = (t: string, p: string, ok: (x: string | undefined) => boolean, what: string) => { const x = v(t, p); if (!ok(x)) bad.push(`${label(c)}: .${t} ${p} = ${x} (${what})`); };
      want("content-wrap", "display", (x) => x === "grid", "grid");
      want("content-wrap", "grid-template-columns", (x) => x === "1fr 320px", "1fr 320px");
      want("content-wrap", "grid-template-rows", (x) => x === undefined, "не оголошується");
      want("rpanel", "display", (x) => x === "flex", "flex");
      want("rpanel", "flex-direction", (x) => x === "column", "column");
      want("rpanel", "max-height", (x) => x === undefined, "не оголошується");
      want("rpanel", "border-left-width", (x) => x === "1px", "1px");
      want("rpanel", "border-left-style", (x) => x === "solid", "solid");
      want("rpanel", "border-left-color", (x) => x === "var(--border)", "var(--border)");
      for (const t of ["rpanel", "content"]) {
        want(t, "position", (x) => x === "relative", "relative (с78)");
        want(t, "overflow-y", (x) => x === "auto", "auto");
        for (const p of MUST_BE_UNSET) want(t, p, (x) => unsetOk(p, x), "не оголошується (чи нейтральне)");
      }
    }
    expect(bad).toEqual([]);
  });

  it("Н-12: вертикальний відступ .topbar — 4px у базі, у кожній щільності й на кожній ширині (кільце фокуса кнопок шапки не виходить за екран)", () => {
    const { computed, contexts } = model();
    const bad: string[] = [];
    for (const c of contexts) for (const p of ["padding-top", "padding-bottom"]) {
      const x = computed("topbar", p, c);
      if (x !== "4px") bad.push(`${label(c)}: .topbar ${p} = ${x}`);
    }
    expect(bad).toEqual([]);
  });

  it("Н-13: там, де видно «☰» (≤480 px), її з кільцем фокуса не перекриває ні заголовок (.topbar > .tb-title), ні перенесений другий рядок шапки — у кожній щільності, при шрифті 100–200%", () => {
    const { computed, contexts } = model();
    const bad: string[] = [];
    let checked = 0;
    for (const c of contexts) {
      const v = (t: string, p: string) => computed(t, p, c);
      if (v("rf-navtoggle", "display") === "none") continue;
      checked++;
      if (v("rf-navtoggle", "position") !== "fixed") { bad.push(`${label(c)}: «☰» видно, але position = ${v("rf-navtoggle", "position")}`); continue; }
      for (const p of ["margin-left", "margin-top", "transform", "translate", "scale", "zoom"]) if (!unsetOk(p, v("rf-navtoggle", p))) bad.push(`${label(c)}: «☰» ${p} = ${v("rf-navtoggle", p)} — зсуває кнопку повз розрахунок`);
      // шапка: для рядка заголовка важливі лише ці відступи — усе інше (tb-right) іде другим рядком
      for (const p of ["margin-left", "margin-top", "margin-bottom", "transform", "translate", "scale", "zoom"]) if (!unsetOk(p, v("tb-title", p))) bad.push(`${label(c)}: .tb-title ${p} = ${v("tb-title", p)} — зсуває заголовок повз розрахунок`);
      for (const root of [16, 20, 24, 28, 32]) {
        const P = (t: string, p: string) => { const x = v(t, p); return x === undefined || x === "auto" || x === "normal" ? 0 : toPx(x, root); };
        const B = (t: string, side: string) => { const st = v(t, `border-${side}-style`); if (st === undefined || st === "none" || st === "hidden") return 0; const w = v(t, `border-${side}-width`) ?? "medium"; return w === "thin" ? 1 : w === "medium" ? 3 : w === "thick" ? 5 : toPx(w, root); };
        // Краї «☰» — ОЦІНКА ЗГОРИ: max(min-, власний розмір) + padding + border (за border-box їх
        // уже враховано в розмірі — тоді оцінка лише більша). Гліф ☰ (1.125rem) вужчий за 2.75rem.
        const right = P("rf-navtoggle", "left") + Math.max(P("rf-navtoggle", "min-width"), P("rf-navtoggle", "width")) + P("rf-navtoggle", "padding-left") + P("rf-navtoggle", "padding-right") + B("rf-navtoggle", "left") + B("rf-navtoggle", "right");
        const bottom = P("rf-navtoggle", "top") + Math.max(P("rf-navtoggle", "min-height"), P("rf-navtoggle", "height")) + P("rf-navtoggle", "padding-top") + P("rf-navtoggle", "padding-bottom") + B("rf-navtoggle", "top") + B("rf-navtoggle", "bottom");
        // Заголовок починається (шапка — від x = 0: сайдбар на ≤480 px поза потоком) …
        const topPad = B("topbar", "left") + P("topbar", "padding-left");
        const titleX = topPad + B("tb-title", "left") + P("tb-title", "padding-left");
        if (titleX < right + RING) bad.push(`${label(c)}@${root}px: текст заголовка з x = ${titleX}px, а «☰» з кільцем — до ${right + RING}px (.topbar padding-left ${v("topbar", "padding-left")}, .tb-title padding-left ${v("tb-title", "padding-left")})`);
        // Резерв — у рядку заголовка, а не на всій шапці: інакше й перенесені кнопки .tb-right
        // зсуваються на ширину «☰» і при шрифті 200% виходять за правий край (ревʼю р2).
        if (topPad >= right) bad.push(`${label(c)}@${root}px: місце під «☰» тримає вся шапка (padding-left ${v("topbar", "padding-left")} = ${topPad}px ≥ ${right}px) — резерв має бути лише в .tb-title`);
        // … а другий рядок (перенесена .tb-right) — не вище за низ «☰»: перший рядок не нижчий за
        // min-height заголовка (ОЦІНКА ЗНИЗУ — справжній рядок лише вищий), далі row-gap шапки.
        const row2 = B("topbar", "top") + P("topbar", "padding-top") + Math.max(P("tb-title", "min-height"), P("tb-title", "height")) + P("topbar", "row-gap");
        if (row2 < bottom + RING) bad.push(`${label(c)}@${root}px: другий рядок шапки з y ≥ ${row2}px, а «☰» з кільцем — до ${bottom + RING}px (.tb-title min-height ${v("tb-title", "min-height")}, row-gap ${v("topbar", "row-gap")})`);
      }
    }
    expect(checked, "пін нічого не перевірив: «☰» ніде не видно").toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });

  it("ревʼю р2: контейнери прокрутки оболонки (.rpanel, .content, .content-full, .sb-nav і .content-wrap з overflow: hidden) тримають scroll-padding-block не менший за кільце фокуса — Tab не ставить елемент упритул до краю, де кільце зрізається", () => {
    const { computed, contexts } = model();
    const bad: string[] = [];
    for (const c of contexts) for (const t of ["rpanel", "content", "content-full", "sb-nav", "content-wrap"]) for (const p of ["scroll-padding-top", "scroll-padding-bottom"]) {
      const x = computed(t, p, c);
      for (const root of [16, 32]) if (x === undefined || x === "auto" || toPx(x, root) < RING) { bad.push(`${label(c)}@${root}px: .${t} ${p} = ${x} (потрібно ≥ ${RING}px)`); break; }
    }
    expect(bad).toEqual([]);
  });

  it("ревʼю р2: на ≤1240 px імена в картках панелі (і назви кабінетів) переносяться — не nowrap, overflow-wrap anywhere|break-word — попри інлайновий style у TSX", () => {
    const { inherited, contexts, nameTargets } = model();
    const names = nameTargets();
    // ланцюжки знайдено з AST: якщо панелі перейменують чи винесуть, пін має почервоніти, а не збіднішати
    expect([...names.comps].sort()).toEqual(expect.arrayContaining(["AffectedPanel", "CallListPanel", "CancelledRow", "NeedsReschedulePanel", "RoomLoad"]));
    const bad: string[] = [];
    for (const c of contexts.filter((x) => x.w <= 1240)) for (const n of names.chains) {
      const mode = inherited(n.key, "text-wrap-mode", c), ow = inherited(n.key, "overflow-wrap", c);
      if (mode !== "wrap") bad.push(`${label(c)}: ${n.what}: text-wrap-mode = ${mode} (імʼя ріжеться, а не переноситься)`);
      if (ow !== "anywhere" && ow !== "break-word") bad.push(`${label(c)}: ${n.what}: overflow-wrap = ${ow} (довге слово вилізе)`);
    }
    expect(bad.slice(0, 20)).toEqual([]);
  });

  it("модель оболонки звірена з TSX (AST): .main, .content-wrap, .topbar > .tb-title — ті самі теги, класи й порядок, на які спираються піни", () => {
    for (const f of ["components/QueueBoard.tsx", "components/RadiologistBoard.tsx"]) {
      const mains: JEl[] = [];
      forEachJsx(sourceOf(f), (n) => { if ((classesOf(n) ?? []).includes("main")) mains.push(n); });
      expect(mains.length, `${f}: .main не знайдено`).toBeGreaterThan(0);
      for (const main of mains) {
        const kids = kidsOf(main);
        expect(kids.map(descOf), `${where(main)}: діти .main`).toEqual(["header.topbar", "div.content-wrap"]);
        expect(kidsOf(kids[1] as JEl).map(descOf), `${where(kids[1])}: діти .content-wrap`).toEqual(["div.content", "aside.rpanel"]);
      }
    }
    // Н-13 спирається на `.topbar > .tb-title` — заголовок мусить бути ПЕРШОЮ дитиною кожної шапки
    // екрана (саме він стоїть під «☰»).
    let headers = 0;
    for (const f of readdirSync(join(process.cwd(), "components")).filter((x) => x.endsWith(".tsx")).map((x) => `components/${x}`)) {
      if (!read(f).includes("topbar")) continue;
      forEachJsx(sourceOf(f), (n) => {
        if (tagOf(n) !== "header" || !(classesOf(n) ?? []).includes("topbar")) return;
        headers++;
        expect(kidsOf(n).map(descOf)[0], `${where(n)}: перша дитина header.topbar`).toBe("div.tb-title");
      });
    }
    expect(headers, "жодної header.topbar — пін нічого не перевірив").toBeGreaterThanOrEqual(12);
    const nav = read("components/NavDrawer.tsx");
    const iToggle = nav.indexOf('className="rf-navtoggle"'), iScrim = nav.indexOf('className={"rf-nav-scrim"'), iAside = nav.indexOf('className={"sidebar"');
    expect(iToggle >= 0 && iToggle < iScrim && iScrim < iAside, "NavDrawer: «☰», скрим, aside.sidebar — у цьому порядку").toBe(true);
    const btn = nav.slice(nav.lastIndexOf("<button", iToggle), nav.indexOf(">", iToggle));
    expect(btn.match(/\b[a-z][-a-zA-Z]*(?==)/g)?.sort()).toEqual(["aria-controls", "aria-expanded", "aria-label", "className", "onClick", "ref", "type"]);
    expect(read("app/layout.tsx")).toMatch(/<html lang="uk"/);
    expect(read("app/layout.tsx")).toContain("document.documentElement.setAttribute('data-density'");
  });
});
