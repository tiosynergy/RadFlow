/* ===== RadFlow — поштова абстракція =====

   SMTP у продукту ПОКИ НЕМАЄ: вбудована пошта Supabase шле лише команді
   проєкту (2 листи/год), «Confirm email» вимкнено свідомо — див.
   claude/smtp-blocker-and-0140-verification.md. Власний SMTP зʼявиться
   разом із доменом.

   Цей модуль — шов, у який SMTP вставиться БЕЗ переробки споживачів:
   зараз isMailerConfigured() каже false, і фічі, яким лист ОБОВʼЯЗКОВИЙ
   (видалення клініки), чесно відмовляють із зрозумілим текстом. Коли
   власник підніме SMTP і заповнить env, лишиться дописати ОДИН draiver у
   sendMail — споживачі не зміняться.

   ⚠️ Фічі не мають права «тимчасово» обходити пошту (показати токен на
   екрані, писати його в лог): підтвердження email — це доказ володіння
   скринькою, і обхід перетворює його на театр. Краще чесне «недоступно». */

const ENV_KEYS = ["RADFLOW_SMTP_URL", "RADFLOW_SMTP_FROM"] as const;

export function isMailerConfigured(): boolean {
  return ENV_KEYS.every((k) => !!process.env[k]?.trim());
}

export interface MailMessage {
  to: string;
  subject: string;
  /** Плейн-текст. HTML свідомо немає: лист підтвердження — це один рядок
      пояснення і одне посилання, верстати тут нічого. */
  text: string;
}

export async function sendMail(msg: MailMessage): Promise<void> {
  if (!isMailerConfigured()) {
    // Не мовчазний no-op: споживач, що не перевірив isMailerConfigured(),
    // має впасти тут, а не вдати, ніби лист пішов.
    throw new Error("mailer_not_configured");
  }
  // Драйвер зʼявиться разом із SMTP (nodemailer або HTTP API провайдера).
  // Навмисно НЕ реалізовано наперед: невідомо, який транспорт обере власник,
  // а мертвий код поруч із секретами — джерело помилок.
  void msg;
  throw new Error("mailer_driver_not_implemented");
}
