import { NextResponse } from "next/server";
import { buildStamp } from "@/lib/buildStamp";

/* ===== GET /api/build — прилад «чи доїхала збірка» (пакет 42, с59) =====

   Віддає `{ stamp, reason, env }`, де `stamp = sha256(commitSha)[:12]`.
   Як користуватись: після пуша порахувати очікуване значення локально —
     node -e "console.log(require('crypto').createHash('sha256').update('<SHA>').digest('hex').slice(0,12))"
   — і звірити з тим, що віддає прод. Збіглось — доїхав САМЕ цей коміт.

   ⚠️ БЕЗ АВТЕНТИФІКАЦІЇ, і це навмисно. Прилад мусить працювати ТОДІ, КОЛИ
   зламано інше: гейт `requireRole` тягне за собою і service-role ключ, і
   Auth, і `profiles` — відмова будь-чого з цього зробила б відповідь
   неоднозначною («стара збірка чи впав Auth?»). Тому роут не читає ні
   сесію, ні базу. Розкриття нульове: 12 hex від приватного SHA і слово
   `production`.

   ⚠️ MIDDLEWARE НЕ ЧІПАЛИ, і це ЗАМІРЯНО, а не припущено: `/api/build`
   не входить у `PROTECTED`, тож редиректу на `/login` не буде, а
   `updateSession` уже ловить падіння Auth (`catch { user = null }`) і
   застосунок не роняє. Додавати шлях у `MACHINE_PREFIXES` заради економії
   одного клієнта Supabase — не та ціна, щоб чіпати спільний файл.

   ⚠️ `no-store` ОБОВʼЯЗКОВИЙ: закешована відповідь віддавала б штамп
   ПОПЕРЕДНЬОЇ збірки, тобто прилад брехав би саме в той момент, заради
   якого існує. Цю властивість пінить тест. */

export const dynamic = "force-dynamic";

export async function GET() {
  const { stamp, reason } = buildStamp(process.env.VERCEL_GIT_COMMIT_SHA);
  return NextResponse.json(
    { stamp, reason, env: process.env.VERCEL_ENV ?? null },
    { headers: { "cache-control": "no-store" } }
  );
}
