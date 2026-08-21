import { NextResponse } from "next/server";
import { z } from "zod";
import { randomBytes, createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRole } from "@/lib/apiAuth";
import { parseBody } from "@/lib/validationHttp";
import { isMailerConfigured, sendMail } from "@/lib/mailer";
import { logError } from "@/lib/serverLog";

/* ===== POST /api/clinic/delete-request =====
   Адміністратор запускає ПОВНЕ видалення свого медичного центру.

   Це ще НЕ видалення: тут лише створюється запит і надсилається лист із
   токеном підтвердження на email адміна. Саме видалення робить
   /api/clinic/delete-confirm ПІСЛЯ переходу за посиланням із листа.

   Чому лист обовʼязковий: видалення незворотне (черга пацієнтів, кабінети,
   послуги, ключі інтеграцій, штат разом з auth-акаунтами). Сесія в браузері
   могла лишитись відкритою на чужій машині; володіння скринькою — окремий
   фактор, який цим не компрометується.

   ⚠️ Поки SMTP не налаштовано (див. lib/mailer.ts) — роут чесно відповідає
   503: обходу «показати токен на екрані» НЕМАЄ свідомо, він перетворив би
   email-підтвердження на театр. */

export const runtime = "nodejs";

const sBody = z.object({
  /* Назву клініки користувач набирає РУКАМИ в модалці — класичний запобіжник
     від «клацнув не туди». Звіряємо на сервері: клієнтську перевірку можна
     обійти правкою DOM. */
  clinicNameConfirmation: z.string().min(1).max(200),
});

const TOKEN_TTL_MIN = 60;

export async function POST(req: Request) {
  const gate = await requireRole(["admin"], {
    needClinic: true,
    forbidden: "Лише адміністратор центру",
  });
  if (!gate.ok) return gate.res;
  const { me } = gate;

  if (!isMailerConfigured()) {
    return NextResponse.json(
      {
        error:
          "Видалення центру потребує підтвердження через email. " +
          "Поштовий сервер (SMTP) ще не налаштовано — функція стане доступною " +
          "після його підключення.",
        code: "mailer_not_configured",
      },
      { status: 503 }
    );
  }

  const parsed = await parseBody(
    "api/clinic/delete-request", req, sBody, "Некоректний запит"
  );
  if (!parsed.ok) return parsed.res;

  const admin = createAdminClient();

  const [{ data: clinic, error: clinicErr }, { data: adminProfile }] = await Promise.all([
    admin.from("clinics").select("id, name").eq("id", me.clinic_id as string).maybeSingle(),
    admin.from("profiles").select("email, full_name").eq("id", me.id).maybeSingle(),
  ]);
  if (clinicErr || !clinic) {
    logError({ event: "clinic.delete_request", errorCode: "clinic_lookup", message: clinicErr?.message ?? null });
    return NextResponse.json({ error: "Тимчасова помилка" }, { status: 500 });
  }

  // Звірка назви — по СИРОМУ рядку після trim, регістр значущий: «приблизно
  // та» назва для незворотної операції не годиться.
  if (parsed.data.clinicNameConfirmation.trim() !== clinic.name) {
    return NextResponse.json(
      { error: "Назва центру не збігається. Наберіть її точно як у налаштуваннях." },
      { status: 400 }
    );
  }

  const email = adminProfile?.email?.trim();
  if (!email) {
    return NextResponse.json(
      { error: "У профілі адміністратора немає email — підтвердження неможливе." },
      { status: 409 }
    );
  }

  // Знімок «що буде видалено» — піде в лист і в модалку.
  const countOf = async (
    table: "queue_entries" | "waitlist_entries" | "rooms" | "services"
         | "profiles" | "integration_keys"
  ) => {
    const { count } = await admin
      .from(table)
      .select("*", { count: "exact", head: true })
      .eq("clinic_id", clinic.id);
    return count ?? 0;
  };
  const counts = {
    queue_entries: await countOf("queue_entries"),
    waitlist_entries: await countOf("waitlist_entries"),
    rooms: await countOf("rooms"),
    services: await countOf("services"),
    profiles: await countOf("profiles"),
    integration_keys: await countOf("integration_keys"),
  };

  /* Токен: 48 hex, у БД — лише sha256 (канон integration_keys: витік таблиці
     не дає виконати видалення). Сирий токен живе тільки в листі. */
  const token = randomBytes(24).toString("hex");
  const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MIN * 60_000).toISOString();

  // Старий живий запит скасовуємо: partial unique дозволяє один живий, і
  // «передумав — натиснув ще раз» має працювати, а не впиратись у 409.
  const { error: cancelErr } = await admin
    .from("clinic_deletion_requests")
    .update({ cancelled_at: new Date().toISOString() })
    .eq("clinic_id", clinic.id)
    .is("executed_at", null)
    .is("cancelled_at", null);
  if (cancelErr) {
    logError({ event: "clinic.delete_request", errorCode: "cancel_prev", message: cancelErr.message });
    return NextResponse.json({ error: "Тимчасова помилка" }, { status: 500 });
  }

  const { data: reqRow, error: insErr } = await admin
    .from("clinic_deletion_requests")
    .insert({
      clinic_id: clinic.id,
      clinic_name: clinic.name,
      admin_id: me.id,
      admin_email: email,
      token_hash: tokenHash,
      counts,
      expires_at: expiresAt,
    })
    .select("id")
    .single();
  if (insErr || !reqRow) {
    logError({ event: "clinic.delete_request", errorCode: "insert", message: insErr?.message ?? null });
    return NextResponse.json({ error: "Тимчасова помилка" }, { status: 500 });
  }

  const base = new URL(req.url).origin;
  const confirmUrl =
    `${base}/api/clinic/delete-confirm?rid=${reqRow.id}&t=${token}`;

  try {
    await sendMail({
      to: email,
      subject: `RadFlow: підтвердіть видалення центру «${clinic.name}»`,
      text:
        `Ви (або хтось із вашої сесії адміністратора) запросили ПОВНЕ видалення ` +
        `медичного центру «${clinic.name}» у RadFlow.\n\n` +
        `Буде БЕЗПОВОРОТНО видалено: записів черги — ${counts.queue_entries}, ` +
        `листа очікування — ${counts.waitlist_entries}, кабінетів — ${counts.rooms}, ` +
        `послуг — ${counts.services}, працівників (разом з обліковими записами, ` +
        `включно з вашим) — ${counts.profiles}, ключів інтеграцій — ${counts.integration_keys}.\n\n` +
        `Якщо це справді ви — перейдіть за посиланням упродовж ${TOKEN_TTL_MIN} хвилин:\n` +
        `${confirmUrl}\n\n` +
        `Якщо це НЕ ви — нічого не робіть: без цього посилання видалення не ` +
        `відбудеться, а запит згасне сам. І змініть пароль адміністратора.`,
    });
  } catch (e) {
    /* Лист не пішов → запит мертвий вантаж: скасовуємо, щоб не блокував
       partial unique наступну спробу після налаштування пошти. */
    await admin
      .from("clinic_deletion_requests")
      .update({ cancelled_at: new Date().toISOString() })
      .eq("id", reqRow.id);
    logError({ event: "clinic.delete_request", errorCode: "mail_failed", message: String(e) });
    return NextResponse.json(
      { error: "Не вдалося надіслати лист підтвердження. Видалення не розпочато." },
      { status: 502 }
    );
  }

  return NextResponse.json({
    ok: true,
    message:
      `Лист підтвердження надіслано на ${email}. Посилання діє ${TOKEN_TTL_MIN} хвилин. ` +
      `Без переходу за ним нічого видалено не буде.`,
  });
}
