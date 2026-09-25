/* с80 (Н-15) — журнал дій називає направника ЗБЕРЕЖЕНОГО рядка, а не форми.
 *
 * ЩО БУЛО. Гард 0203 (`zz_guard_read_keys`) мовчки обнуляє `referrer_id`, якщо
 * направник не має активного гранту до центру запису (рішення власника Р-2:
 * NULL, а не відмова). А події `important_events` застосунок писав із ВХОДУ:
 * `subjectReferrerId: input.referrerId` у createBooking / createCase і з
 * ВИХІДНОГО рядка — у caseFromEntry та двох шляхах листа очікування. Тобто
 * журнал міг сказати «referral.created, направник X» про запис, у якому
 * направника немає. Доступу це не відкривало (журнал читають адмін і CEO
 * центру, ПДн там немає), але слід і фільтри журналу брехали (L-b ревʼю р3 0203).
 *
 * ЯК ЛІКУЄМО. Сімʼя події (referral.* / queue.* / case.*) і subject_referrer_id —
 * з рядка ПІСЛЯ запису: RETURNING там, де вставка пряма, і читання назад там,
 * де рядок створює RPC, що повертає лише id. Не прочитали — направника НЕ
 * вигадуємо (NULL) і пишемо гучний лог.
 *
 * Чому статичний, а не поведінковий: екшени тягнуть по пів десятка гейтів
 * (модальність, графік, перетин, годинник) — двійник для них був би більшим за
 * самі правки. Тут пінимо ФОРМУ: звідки береться направник події. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { codeOf } from "./helpers/codeOf";

const queue = codeOf(readFileSync(resolve(process.cwd(), "app/queue/actions.ts"), "utf8"));
const waitlist = codeOf(readFileSync(resolve(process.cwd(), "app/waitlist/actions.ts"), "utf8"));

/** Тіло експортованої функції — від `export async function <name>(` до наступного `export `. */
function fnBody(code: string, name: string): string {
  const start = code.indexOf(`export async function ${name}(`);
  expect(start, `функцію ${name} не знайдено`).toBeGreaterThanOrEqual(0);
  const next = code.indexOf("\nexport ", start + 10);
  return code.slice(start, next < 0 ? undefined : next);
}

describe("журнал бере направника зі ЗБЕРЕЖЕНОГО рядка (Н-15)", () => {
  it("жодна подія не називає направника з форми", () => {
    expect(queue).not.toMatch(/subjectReferrerId: input\.referrerId/);
    expect(queue).not.toMatch(/const referral = Boolean\(input\.referrerId\)/);
  });

  it("createBooking: RETURNING referrer_id — і сімʼя, і subject з нього", () => {
    const b = fnBody(queue, "createBooking");
    expect(b).toMatch(/\}\)\.select\("id, referrer_id"\)\.single\(\);/);
    expect(b).toMatch(/const savedReferrerId = created\.referrer_id \?\? null;\s*const referral = Boolean\(savedReferrerId\);/);
    expect(b).toMatch(/subjectReferrerId: savedReferrerId,/);
  });

  it("createCase і caseFromEntry: направник — із кейса, прочитаного ПІСЛЯ RPC", () => {
    for (const name of ["createCase", "caseFromEntry"]) {
      const b = fnBody(queue, name);
      expect(b, name).toMatch(/const savedReferrerId = await savedCaseReferrer\(supabase, user\.id, caseId, "[a-z_.]+"\);\s*const referral = Boolean\(savedReferrerId\);/);
      expect(b, name).toMatch(/subjectReferrerId: savedReferrerId,/);
      // Порядок: читання назад стоїть ПІСЛЯ RPC (інакше гард ще не відпрацював).
      expect(b.indexOf("savedCaseReferrer("), name).toBeGreaterThan(b.indexOf("supabase.rpc("));
    }
    // caseFromEntry більше не бере направника події з вихідного запису.
    expect(fnBody(queue, "caseFromEntry")).not.toMatch(/subjectReferrerId: srcEntry/);
  });

  it("savedCaseReferrer: RLS-клієнт, readRow, незнання → NULL і гучний лог (не вигадуємо направника)", () => {
    const m = queue.match(/async function savedCaseReferrer\([\s\S]*?\n\}/);
    expect(m).not.toBeNull();
    const f = m![0];
    expect(f).toMatch(/readRow\(await supabase\.from\("patient_cases"\)\.select\("referrer_id"\)\.eq\("id", caseId\)\.maybeSingle\(\)\)/);
    expect(f).toMatch(/if \(!r\.known\) \{[\s\S]*?event: "important_event\.skipped"[\s\S]*?errorCode: "post_snapshot_unreadable"[\s\S]*?return null;\s*\}/);
    expect(f).toMatch(/return r\.row\.referrer_id \?\? null;/);
    // Не service-role: межа читання — RLS персоналу.
    expect(f).not.toMatch(/createAdminClient/);
  });

  it("лист очікування: обидві вставки повертають referrer_id, подія — з нього", () => {
    for (const name of ["addWaitlistEntry", "addEntryToWaitlist"]) {
      const b = fnBody(waitlist, name);
      expect(b, name).toMatch(/\.select\("id, referrer_id"\)\s*\.single\(\);/);
      expect(b, name).toMatch(/const savedReferrerId = data\.referrer_id \?\? null;/);
      expect(b, name).toMatch(/isReferralAction\(\{ entryReferrerId: savedReferrerId, actorRole: caller\.role \}\)/);
      expect(b, name).toMatch(/subjectReferrerId: savedReferrerId,/);
    }
    expect(waitlist).not.toMatch(/entryReferrerId: entry\.referrer_id/);
    expect(waitlist).not.toMatch(/subjectReferrerId: referrerId,/);
  });
});
