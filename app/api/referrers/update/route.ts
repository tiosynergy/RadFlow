import { NextResponse } from "next/server";

// POST /api/referrers/update — ВИМКНЕНО.
// Дані направника тепер змінює ЛИШЕ сам направник у своєму профілі
// (/api/referral/profile). Адміністратор їх не редагує.
export async function POST() {
  return NextResponse.json(
    { error: "Адміністратор не редагує дані направника — це робить сам направник у своєму профілі" },
    { status: 410 }
  );
}
