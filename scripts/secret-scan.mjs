// ============================================================
//  scripts/secret-scan.mjs — скан ВСЕЙ истории git на секреты.
//
//  Заведён в с50 (фаза 2 глубокого аудита). Причина завести именно
//  файл в репозитории, а не разовый скрипт: одноразовый сканер живёт
//  в сессии агента и умирает вместе с ней — следующая утечка будет
//  проверяться заново и, скорее всего, теми же неполными правилами.
//
//  ⚠️ ГЛАВНЫЙ УРОК, ради которого файл существует. Первая версия
//  правил (с50) не содержала формата ключей САМОГО проекта (`rfk_`) —
//  и честно вернула «ноль попаданий» на истории, в которой лежат два
//  настоящих интеграционных токена. Сканер, не знающий, что охраняет,
//  зелёный всегда. Поэтому:
//    • правила ниже начинаются с форматов ЭТОГО проекта;
//    • есть режим `--selftest`, который требует, чтобы правило `rfk`
//      нашло известный ground truth в истории. Красный selftest = сканеру
//      верить нельзя, а не «секретов нет».
//
//  ⚠️ Значения секретов НЕ выводятся: печатается имя правила, путь,
//  blob и маска (первые 4 символа + длина).
//
//  ⚠️ Границы, которые скан НЕ покрывает по построению (называть вслух,
//  а не забывать): сжатые контейнеры (`.zip`, `.docx`, `.tar.gz`) —
//  regex по сырому блобу их содержимое не видит; голые
//  высокоэнтропийные значения без узнаваемого префикса; секреты в
//  бинарных форматах. Несжатые `.tar` скан видит насквозь.
//
//  Запуск:  node scripts/secret-scan.mjs
//           node scripts/secret-scan.mjs --selftest
// ============================================================

import { execSync, spawnSync } from "node:child_process";

const SELFTEST = process.argv.includes("--selftest");

const RULES = [
  // --- форматы САМОГО проекта: они первые не случайно ---
  { name: "rfk-token", re: /rfk_[A-Za-z0-9_-]{16,}/g },
  { name: "webhook-secret", re: /whsec_[A-Za-z0-9_-]{16,}/g },
  // --- общие классы ---
  { name: "jwt", re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: "private-key-block", re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g },
  { name: "google-client-secret", re: /GOCSPX-[A-Za-z0-9_-]{10,}/g },
  { name: "aws-akid", re: /AKIA[0-9A-Z]{16}/g },
  { name: "openai-like", re: /\bsk-[A-Za-z0-9]{24,}/g },
  { name: "xai-like", re: /\bxai-[A-Za-z0-9]{24,}/g },
  // ⚠️ [ \t]* вместо \s*: со \s* у переменной с ПУСТЫМ значением регексп
  // перепрыгивал перевод строки и цеплял ИМЯ следующей переменной —
  // ложное срабатывание, потраченное время (с50).
  {
    name: "assigned-secret",
    re: /(?:SERVICE_ROLE_KEY|WEBHOOK_SECRET|CRON_SECRET|CLIENT_SECRET|ANON_KEY|_TOKEN|_PASSWORD)[ \t]*[:=][ \t]*["']?([A-Za-z0-9_\-.\/+]{24,})["']?/g,
  },
];

const PLACEHOLDER = /^(your|placeholder|example|changeme|xxx|<|\.\.\.|dummy|fake|test|sample|replace)/i;
const mask = (s) => `${s.slice(0, 4)}…(len=${s.length})`;

const sh = (cmd) => execSync(cmd, { maxBuffer: 1 << 28 }).toString();

const pathOf = new Map();
for (const line of sh("git rev-list --objects --all").split("\n")) {
  const i = line.indexOf(" ");
  if (i > 0) pathOf.set(line.slice(0, i), line.slice(i + 1));
}

const blobs = [];
for (const line of sh("git cat-file --batch-check --batch-all-objects").split("\n")) {
  const [oid, type, size] = line.split(" ");
  if (type === "blob") blobs.push({ oid, size: Number(size) });
}

const findings = new Map();
let scanned = 0;

// ⚠️ Один `git cat-file --batch` на всю историю, а не spawn на каждый блоб:
// на Windows запуск процесса дорогой, и поблобовый вариант превращает
// десяток секунд в минуты (замерено в с50). Разбор — по БАЙТАМ, потому что
// в истории есть tar и docx: посимвольный split по ним развалится.
const oids = blobs.filter((b) => b.size > 0).map((b) => b.oid);
const empty = blobs.length - oids.length;
const batch = spawnSync("git", ["cat-file", "--batch"], {
  input: oids.join("\n") + "\n",
  maxBuffer: 1 << 30,
});
if (batch.status !== 0) {
  console.error("git cat-file --batch не отработал — скану верить нельзя");
  process.exit(2);
}

const buf = batch.stdout;
let off = 0;
while (off < buf.length) {
  const nl = buf.indexOf(0x0a, off);
  if (nl < 0) break;
  const header = buf.toString("latin1", off, nl).split(" ");
  if (header.length < 3) {
    off = nl + 1; // "<oid> missing" — пропускаем строку
    continue;
  }
  const oid = header[0];
  const size = Number(header[2]);
  const start = nl + 1;
  const txt = buf.toString("latin1", start, start + size);
  off = start + size + 1; // +1 — перевод строки после содержимого
  scanned++;
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(txt)) !== null) {
      const val = m[1] || m[0];
      if (PLACEHOLDER.test(val)) continue;
      const p = pathOf.get(oid) || "(недостижим из веток)";
      // ⚠️ Ключ — БЕЗ маски. Первая версия схлопывала находки по маске, а у
      // двух разных токенов одного формата маска одинаковая (`rfk_…(len=52)`):
      // два реальных ключа в одном файле считались за один, и selftest краснел
      // на исправном сканере. Считать надо РАЗНЫЕ значения (с50).
      const key = `${rule.name}|${p}`;
      const cur = findings.get(key) || { rule: rule.name, path: p, masked: mask(val), values: new Set(), blobs: new Set() };
      cur.values.add(val); // только в памяти, наружу не печатается
      cur.blobs.add(oid.slice(0, 10));
      findings.set(key, cur);
    }
  }
}

const list = [...findings.values()];
console.log(`блобов: ${blobs.length} (пустых ${empty}, просканировано ${scanned})`);
console.log(`совпадений: ${list.length}`);
for (const f of list) {
  console.log(
    `- ${f.rule}  путь=${f.path}  разных значений=${f.values.size}  образец=${f.masked}  блобов=${f.blobs.size}`
  );
}

if (!SELFTEST) {
  // Известные и разобранные попадания (инцидент 11.08 + тестовая константа)
  // НЕ делают прогон красным — иначе сторожа снимут как «вечно красный»
  // (урок 0141). Красное = что-то СВЕРХ известного.
  const known = list.filter(
    (f) => f.path === "Integration_KEY.txt" || f.path.startsWith("tests/")
  );
  const fresh = list.filter((f) => !known.includes(f));
  console.log(`\nиз них известных и разобранных: ${known.length} (инцидент 11.08 — ключи в проде удалены, сверено в с50; и константа в тестах)`);
  if (fresh.length) {
    console.error(`\nНОВЫЕ ПОПАДАНИЯ: ${fresh.length} — разобрать каждое.`);
    process.exit(1);
  }
  console.log("новых попаданий нет");
  process.exit(0);
}

// --- SELFTEST: сканер обязан находить ground truth ---
// В истории публичного репозитория лежит `Integration_KEY.txt` с двумя
// токенами `rfk_` (инцидент 11.08.2026). Если правило `rfk-token` их не
// видит — сканеру нельзя верить, и «ноль попаданий» ничего не значит.
const gt = list.filter((f) => f.rule === "rfk-token" && f.path === "Integration_KEY.txt");
const gtTokens = gt.reduce((n, f) => n + f.values.size, 0);
console.log(`\nSELFTEST: правило rfk-token на Integration_KEY.txt → ${gtTokens} разных токена (ожидается 2)`);
if (gtTokens < 2) {
  console.error("SELFTEST FAILED: сканер не видит известные токены. Верить его «нулю» нельзя.");
  process.exit(1);
}
console.log("SELFTEST OK");
process.exit(0);
