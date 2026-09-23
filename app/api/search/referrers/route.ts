import { NextResponse } from "next/server";
import { requireRole } from "@/lib/apiAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadReferrerDirectory, resolveSearchScope } from "@/lib/searchEngine.server";
import { buildReferrerOptions } from "@/lib/searchReferrerFilter";

/* ===== GET /api/search/referrers — опції селекта «Направник» (с77) =====

   Лише ролям, яким видно направника (персонал центру і CEO); направнику — 403.
   Центри — з області, яку рахує сервер із сесії (resolveSearchScope), тож
   чужий центр сюди не потрапить ні за яких параметрів: параметрів немає.

   Імена читає admin-клієнт (за RLS їх бачить лише адмін — замір с77), і рівно в
   межах цих центрів: акаунти з грантом у центр + картки довідника центру. */

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireRole(null, { rateLimit: { key: "search_referrers", max: 30, windowSeconds: 60 } });
  if (!gate.ok) return gate.res;
  const { supabase, me } = gate;

  const scope = await resolveSearchScope(supabase, me);
  if ("error" in scope) return NextResponse.json({ error: scope.error }, { status: scope.status });
  if (!scope.referrerVisible) return NextResponse.json({ error: "Недостатньо прав" }, { status: 403 });
  if (!scope.clinicIds.length) {
    return NextResponse.json({ accounts: [], cards: [] }, { headers: { "Cache-Control": "no-store" } });
  }

  const dir = await loadReferrerDirectory(createAdminClient(), scope.clinicIds);
  if (!dir.ok) return NextResponse.json({ error: dir.error }, { status: 400 });

  const clinicNameById: Record<string, string> = {};
  if (scope.clinicIds.length > 1) {
    const { data } = await supabase.from("clinics").select("id, name").in("id", scope.clinicIds);
    (data || []).forEach((c) => { clinicNameById[String(c.id)] = c.name || ""; });
  }
  const opts = buildReferrerOptions(dir.dir, clinicNameById, scope.clinicIds.length > 1);
  return NextResponse.json(opts, { headers: { "Cache-Control": "no-store" } });
}
