import { createServerClient, type SetAllCookies } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Routes that require authentication.
const PROTECTED = [
  "/setup",
  "/queue",
  "/board-app",
  "/radiologist",
  "/call-list",
  "/incidents",
  "/ceo",
  "/referral",
  "/staff",
  "/referrers",
];

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

  // IMPORTANT: do not run code between createServerClient and getUser,
  // otherwise the session may end unexpectedly.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;

  // Корінь сайту: ведемо на дошку (увійшов) або на вхід. /queue сам
  // перенаправляє за роллю (радіолог → /radiologist, направник → /referral).
  if (path === "/") {
    const url = request.nextUrl.clone();
    url.pathname = user ? "/queue" : "/login";
    return NextResponse.redirect(url);
  }

  if (!user && matches(path, PROTECTED)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("redirect", path);
    return NextResponse.redirect(url);
  }

  if (user && matches(pa