"use client";

/* ===== RadFlow — посилання на дашборд CEO для крос-рольових користувачів =====
   Радіолог/направник/реєстратор може мати ДОДАТКОВО грант CEO (ceo_access).
   Їхні екрани не мають сайдбару з посиланням на /ceo, тож показуємо компактне
   посилання у шапці — лише якщо у користувача є активний CEO-доступ.
   Самодостатній: сам перевіряє ceo_access (RLS ceo_access_self_select). */

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function CeoDashboardLink({ className = "btn btn-secondary btn-sm" }: { className?: string }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const supabase = createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user || !active) return;
        const { data } = await supabase
          .from("ceo_access")
          .select("clinic_id")
          .eq("ceo_id", user.id)
          .eq("status", "active")
          .limit(1);
        if (active && (data?.length ?? 0) > 0) setShow(true);
      } catch { /* ignore — посилання просто не зʼявиться */ }
    })();
    return () => { active = false; };
  }, []);

  if (!show) return null;
  return <a href="/ceo" className={className} title="Перейти до дашборда CEO">📊 Дашборд CEO</a>;
}
