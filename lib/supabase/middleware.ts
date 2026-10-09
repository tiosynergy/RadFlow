import { createServerClient, type SetAllCookies } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { isOperatorByClaim, PLATFORM_HOME } from "@/lib/platformClaim";

/* Routes that require authentication.

   ⚠️ Ф6-2 (с55): звідси прибрано `/board-app` і `/incidents` — сторінок із
   такими шляхами в `app/` НЕМАЄ (перевірено переліком тек). Мертвий запис сам
   по собі нешкідливий, шкідливо було інше: цей allowlist рукописний, і до с55
   його не звіряв із деревом ЖОДЕН тест. Тепер звіряє `tests/authSurface.test.ts`
   в обидва боки: сторінка поза списком і запис без сторінки однаково червоні. */
const PROTECTED = [
  "/setup",
  "/queue",
  "/radiologist",
  "/call-list",
  "/waitlist",
  "/ceo",
  "/ceo-admin",
  "/referral",
  "/staff",
  "/referrers",
  "/services",
  "/search",
  "/journal",
  "/platform",
];

/* 0206 (с84): консоль оператора платформи. Оператор — акаунт БЕЗ профілю і без
   `user_role`; куди його вести, middleware читає з `app_metadata.platform`
   (ставить лише сервер — lib/platformClaim.ts). Це МАРШРУТИЗАЦІЯ: права дає
   рядок `platform_operators` на сервері (сторінка і кожен роут перевіряють самі).
   Оператор на клінічній сторінці → /platform (інакше сторінка без профілю вела б
   на /api/auth/reset і гасила б сесію); персонал центру на /platform → /queue. */
const PLATFORM = ["/platform"];

// Auth pages: a logged-in user is redirected to the dashboard.
const AUTH_PAGES = ["/login", "/register"];

function matches(path: string, list: string[]): boolean {
  return list.some((p) => path === p || path.startsWith(p + "/"));
}

// Refreshes the Supabase session on each request and guards routes.
// If Supabase is not configured yet (no env vars), the request passes through
// so the dev server keeps working before the Supabase project is created.
export async function updateSession(request: NextRequest) {
  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  ) {
    return NextResponse.next({ request });
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: Parameters<SetAllCookies>[0]) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  /* IMPORTANT: do not run code between createServerClient and getUser,
     otherwise the session may end unexpectedly.

     M-11 (аудит 2026-07-12): getUser() ходить у Supabase Auth по мережі. Штатну
     помилку auth-js віддає в { error }, АЛЕ мережевий збій (DNS, інцидент на боці
     Supabase, обрив під час _refreshAccessToken) кидає `TypeError: fetch failed`.
     Без try/catch цей throw валить middleware, а він висить на всьому matcher —
     тобто 500 отримує ВЕСЬ сайт, включно з /login: користувач не може навіть
     перезайти. Ловимо і деградуємо fail-closed: вважаємо, що сесії немає
     (захищені сторінки → /login), публічні сторінки працюють. */
  let user: { id: string; app_metadata?: Record<string, unknown> | null } | null = null;
  try {
    const { data } = await supabase.auth.getUser();
    user = data.user ?? null;
  } catch {
    user = null;   // мережа/Auth недоступні — не роняємо застосунок
  }

  const path = request.nextUrl.pathname;
  const operator = isOperatorByClaim(user);
  const home = operator ? PLATFORM_HOME : "/queue";

  // Корінь сайту: ведемо на дошку (увійшов) або на вхід. /queue сам
  // перенаправляє за роллю (радіолог → /radiologist, направник → /referral);
  // оператор платформи (0206) — одразу в консоль.
  if (path === "/") {
    const url = request.nextUrl.clone();
    url.pathname = user ? home : "/login";
    return NextResponse.redirect(url);
  }

  if (!user && matches(path, PROTECTED)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("redirect", path);
    return NextResponse.redirect(url);
  }

  if (user && matches(path, AUTH_PAGES)) {
    const url = request.nextUrl.clone();
    url.pathname = home;
    return NextResponse.redirect(url);
  }

  /* 0206: оператор і персонал центру живуть у різних контурах — чужий контур
     веде у свій дім. Обидві гілки лише маршрутизують; відмову дає сервер. */
  if (user && operator && matches(path, PROTECTED) && !matches(path, PLATFORM)) {
    const url = request.nextUrl.clone();
    url.pathname = PLATFORM_HOME;
    return NextResponse.redirect(url);
  }
  if (user && !operator && matches(path, PLATFORM)) {
    const url = request.nextUrl.clone();
    url.pathname = "/queue";
    return NextResponse.redirect(url);
  }

  return response;
}
