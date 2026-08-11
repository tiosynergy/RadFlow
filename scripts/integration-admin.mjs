/* RadFlow — адмін-CLI інтеграцій (фаза 1, 0144/0145). Запускає ВЛАСНИК
   локально (потрібні NEXT_PUBLIC_SUPABASE_URL і SUPABASE_SERVICE_ROLE_KEY у
   .env.local або env). Це єдиний канал видачі ключів у фазі 1 — адмін-UI нема.

     node scripts/integration-admin.mjs key:create --clinic <uuid> --name "RIS Х" \
          [--scopes slots:read,appointments:read,events:write] [--mode A|B]
     node scripts/integration-admin.mjs key:revoke --id <uuid>
     node scripts/integration-admin.mjs webhook:set --clinic <uuid> --url https://… \
          [--secret <32+ символів; без опції — згенерується]
     node scripts/integration-admin.mjs webhook:disable --clinic <uuid>
     node scripts/integration-admin.mjs list --clinic <uuid>

   Секрети (токен ключа, секрет вебхука) друкуються РІВНО ОДИН РАЗ — у БД
   лишається тільки sha256-хеш токена (0144) і секрет вебхука у deny-all
   таблиці (0145). Втратили токен → key:revoke + key:create.

   Канон Node-скриптів проєкту: split lib+CLI, main() виконується безумовно
   (жодних guard-ів по argv[1] — молчаливий no-op на симлінках/Windows). */

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import {
  generateToken, hashToken, tokenPrefix, generateWebhookSecret,
  parseScopes, validateWebhookUrl, isUuid, parseArgs, ALLOWED_SCOPES,
} from "./integration-admin-lib.mjs";

/** .env.local — того ж формату, що читає Next; беремо лише потрібні ключі.
    Inline-коментар після значення без лапок зрізаємо (інакше хвіст « # prod»
    поїхав би в SUPABASE_SERVICE_ROLE_KEY і дав незрозумілий 401). */
function loadEnvLocal() {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
    if (!m || process.env[m[1]] !== undefined) continue;
    let v = m[2];
    if (/^["']/.test(v)) v = v.replace(/^["']|["']$/g, "");
    else v = v.replace(/\s+#.*$/, "").trim();
    process.env[m[1]] = v;
  }
}

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Потрібні NEXT_PUBLIC_SUPABASE_URL і SUPABASE_SERVICE_ROLE_KEY (.env.local)");
    process.exit(2);
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Нагадування ПІСЛЯ друку секрету. Не косметика: 11.08.2026 вивід цієї
    команди зберегли у файл поруч із проєктом, і файл поїхав у ПУБЛІЧНИЙ
    репозиторій із двома живими ключами. Приватність історії після push не
    відновлюється — лише перевипуск. Тому попередження стоїть саме тут, поки
    секрет ще на екрані, а не в README, який читають один раз. */
function warnSecretHandling(what) {
  console.log("");
  console.log(`  ⚠️  Не зберігайте ${what} у файл всередині репозиторію.`);
  console.log("     Менеджер паролів або захищений канал інтегратору — і все.");
  console.log("     Втратили → key:revoke + key:create (перевипуск дешевий).");
}

function needUuid(opts, name) {
  const v = opts[name];
  if (!isUuid(v)) {
    console.error(`--${name}: очікую uuid`);
    process.exit(2);
  }
  return v;
}

async function main() {
  loadEnvLocal();
  const { cmd, opts } = parseArgs(process.argv.slice(2));

  if (cmd === "help" || cmd === "--help") {
    console.log("Команди: key:create | key:revoke | webhook:set | webhook:disable | list (див. шапку файла)");
    return;
  }

  const db = adminClient();

  if (cmd === "key:create") {
    const clinic = needUuid(opts, "clinic");
    const name = String(opts.name || "").trim();
    if (!name) { console.error("--name: обов'язкове ім'я інтеграції"); process.exit(2); }
    const scopes = parseScopes(opts.scopes ?? ALLOWED_SCOPES.join(","));
    const mode = String(opts.mode ?? "A").toUpperCase();
    if (mode === "B") {
      // Ярлик «демографія назовні» без реалізації вводив би власника в оману:
      // жоден роут фази 1 exportMode не читає — PII не віддається НІДЕ.
      console.error("--mode B у фазі 1 НЕ реалізовано (роути віддають лише режим A). " +
        "Вмикається окремим пакетом після підписаної угоди з клінікою (план §3.1).");
      process.exit(2);
    }
    if (mode !== "A") { console.error("--mode: лише A у фазі 1"); process.exit(2); }
    const token = generateToken();
    const { data, error } = await db.from("integration_keys").insert({
      clinic_id: clinic,
      name,
      key_prefix: tokenPrefix(token),
      key_hash: hashToken(token),
      scopes,
      export_mode: mode,
    }).select("id").single();
    if (error) { console.error("Не вдалось створити ключ:", error.message); process.exit(1); }
    console.log(`Ключ створено: id=${data.id}`);
    console.log(`  clinic:  ${clinic}`);
    console.log(`  scopes:  ${scopes.join(", ")}   режим: ${mode}`);
    console.log(`  ТОКЕН (показується ОДИН раз, передайте інтегратору захищеним каналом):`);
    console.log(`  ${token}`);
    warnSecretHandling("ключ");
    return;
  }

  if (cmd === "key:revoke") {
    const id = needUuid(opts, "id");
    const { data, error } = await db.from("integration_keys")
      .update({ active: false, revoked_at: new Date().toISOString() })
      .eq("id", id)
      .is("revoked_at", null)
      .select("id")
      .maybeSingle();
    if (error) { console.error("Не вдалось відкликати:", error.message); process.exit(1); }
    console.log(data ? `Ключ ${id} відкликано.` : `Ключ ${id} не знайдено або вже відкликаний.`);
    return;
  }

  if (cmd === "webhook:set") {
    const clinic = needUuid(opts, "clinic");
    const url = validateWebhookUrl(opts.url);
    if (opts.secret === true) {
      // «--secret» без значення інакше МОВЧКИ ротував би секрет — RIS перестав
      // би проходити перевірку підпису без жодного попередження
      console.error("--secret вимагає значення (без опції — згенерується новий)");
      process.exit(2);
    }
    const provided = typeof opts.secret === "string" ? opts.secret : null;
    if (provided && provided.length < 32) { console.error("--secret: мінімум 32 символи"); process.exit(2); }
    const secret = provided ?? generateWebhookSecret();
    const { error } = await db.from("integration_webhooks").upsert(
      { clinic_id: clinic, url, secret, enabled: true, updated_at: new Date().toISOString() },
      { onConflict: "clinic_id" }
    );
    if (error) { console.error("Не вдалось зберегти вебхук:", error.message); process.exit(1); }
    console.log(`Вебхук клініки ${clinic} → ${url} (enabled).`);
    if (!provided) {
      console.log(`  СЕКРЕТ ПІДПИСУ (показується ОДИН раз; RIS звіряє X-RadFlow-Signature):`);
      console.log(`  ${secret}`);
      warnSecretHandling("секрет вебхука");
    }
    return;
  }

  if (cmd === "webhook:disable") {
    const clinic = needUuid(opts, "clinic");
    const { data, error } = await db.from("integration_webhooks")
      .update({ enabled: false, updated_at: new Date().toISOString() })
      .eq("clinic_id", clinic)
      .select("id")
      .maybeSingle();
    if (error) { console.error("Не вдалось вимкнути:", error.message); process.exit(1); }
    console.log(data ? `Вебхук клініки ${clinic} вимкнено.` : "Вебхука не було.");
    return;
  }

  if (cmd === "list") {
    const clinic = needUuid(opts, "clinic");
    const [keys, hooks] = await Promise.all([
      db.from("integration_keys")
        .select("id, name, key_prefix, scopes, export_mode, active, revoked_at, last_used_at, created_at")
        .eq("clinic_id", clinic).order("created_at"),
      db.from("integration_webhooks")
        .select("url, enabled, updated_at").eq("clinic_id", clinic),
    ]);
    if (keys.error) { console.error(keys.error.message); process.exit(1); }
    if (hooks.error) { console.error(hooks.error.message); process.exit(1); }
    console.log("Ключі:");
    for (const k of keys.data ?? []) {
      console.log(`  ${k.id}  ${k.key_prefix}…  «${k.name}»  ${k.scopes.join(",")}  режим=${k.export_mode}  ` +
        (k.active && !k.revoked_at ? "АКТИВНИЙ" : "відкликаний") +
        (k.last_used_at ? `  останнє звернення: ${k.last_used_at}` : "  (не використовувався)"));
    }
    if (!(keys.data ?? []).length) console.log("  (немає)");
    console.log("Вебхук:");
    for (const h of hooks.data ?? []) {
      console.log(`  ${h.url}  ${h.enabled ? "enabled" : "ВИМКНЕНО"}  (оновлено ${h.updated_at})`);
    }
    if (!(hooks.data ?? []).length) console.log("  (немає)");
    return;
  }

  console.error(`Невідома команда «${cmd}». Доступні: key:create, key:revoke, webhook:set, webhook:disable, list`);
  process.exit(2);
}

await main();
