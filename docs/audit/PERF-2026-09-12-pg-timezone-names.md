# pg_timezone_names у гарячому шляху (2026-09-12)

Знайдено попутно під час виміру RF-07. **Нічого не змінено** — це вимір і
пропозиція пакета.

## 1. Найдорожчий запит проєкту

`pg_stat_statements`, роль `authenticated`:

| функція | виклики | сумарно | середнє | min | max | sd |
|---|---|---|---|---|---|---|
| `room_busy_slots` (2 арг.) | 31 233 | 8 898 393 мс | **284.9 мс** | 1.88 мс | 5091 мс | 852 |
| `room_busy_slots` (3 арг.) | 12 742 | 1 124 331 мс | 88.2 мс | 1.99 мс | 6221 мс | 290 |
| `room_busy_slots` (інші) | 2 312 | 23 497 мс | 10.2 мс | 1.02 мс | 154 мс | 12 |

Разом ≈ **10.05 млн мс ≈ 20 % часу виконання всього інстансу** (загалом
≈ 50.1 млн мс).

Профіль буферів однаковий у швидких і повільних записів — **642–692
`shared_blks_hit` на виклик, `shared_blks_read = 0`, temp = 0**. Тобто
розкид у 1.88 мс … 5091 мс **не пояснюється ні введенням-виведенням, ні
кількістю рядків**. Це чистий CPU або робота поза обліком shared buffers.

## 2. Що саме коштує

`room_busy_slots` містить:

```sql
when qe.status = 'in_progress' and qe.in_progress_at is not null
  then (qe.in_progress_at at time zone
         coalesce((select name from pg_timezone_names where name = c.timezone), 'UTC'))
```

`pg_timezone_names` — не таблиця, а функція, що на кожен скан розбирає ~1200
записів tz-бази ОС. Її вартість **не потрапляє в `shared_blks`** — що точно
збігається з профілем із п.1.

Заміряно на живій базі:

```
explain (analyze, buffers)
select (select name from pg_timezone_names where name = c.timezone) from clinics c;

Seq Scan on clinics c  (actual time=819.153..819.252 rows=2)
  Buffers: shared hit=1
  SubPlan 1
    ->  Function Scan on pg_timezone_names (actual time=409.582..409.599 rows=1 loops=2)
          Rows Removed by Filter: 1195
Execution Time: 819.421 ms
```

**409 мс на один холодний скан**, ~1.3 мс на теплий. Буферів — один.

## 3. Червоний вимір і зелена база

У `room_busy_slots` виклик стоїть у **корельованому підзапиті**, тому
виконується **на кожен рядок**, хоча параметр (`c.timezone`) щоразу
однаковий. Доведено на вибірці з 50 рядків:

**ЧЕРВОНЕ — як зараз:**
```
SubPlan 1
  ->  Function Scan on pg_timezone_names (actual time=1.265..1.272 rows=1 loops=50)
        Rows Removed by Filter: 1195
Seq Scan on queue_entries   ← план деградував
Execution Time: 67.968 ms
```

**ЗЕЛЕНЕ — той самий набір рядків, `coalesce(c.timezone,'UTC')` напряму:**
```
Index Scan using queue_date_idx on queue_entries   ← план відновився
Execution Time: 0.616 ms
```

**67.97 мс → 0.62 мс, ×110 на тих самих рядках.** Побічно: оцінка вартості
SubPlan-у збивала планувальник із `queue_date_idx` на seq scan.

## 4. Межі твердження (що НЕ доведено)

* Гілка з `pg_timezone_names` спрацьовує **тільки для рядків
  `in_progress`** — `CASE` коротко замикається. Станом на зараз
  `in_progress` рядків **нуль**, тож зараз функція дешева. Множник
  проявляється в робочі години.
* Середнє 284.9 мс — це **середнє за весь час життя запису** (`stats_since
  = 2026-07-14`), і тіло функції за цей час змінювалося (0156 подано
  2026-08-25). **Приписати всі 284.9 мс саме tz-підзапиту не можна.**
  Доведено: (а) сам скан коштує 409 мс холодним, (б) у цій функції він
  пер-рядковий, (в) профіль буферів збігається з «дорого, але поза
  shared_blks».
* Для точної цифри потрібен живий замір `room_busy_slots` під справжнім
  JWT і за наявності `in_progress` рядка.

## 5. Де ще той самий візерунок

`pg_timezone_names` присутній у **шести** функціях:

| функція | позиція виклику | наслідок |
|---|---|---|
| `room_busy_slots(uuid,date,uuid)` | корельований підзапит | **на кожен рядок** |
| `check_no_overlap()` | `select … into v_tz` | 1 скан на **рядок тригера** |
| `check_not_in_past()` | `select … into v_tz` | 1 скан на **рядок тригера** |
| `queue_set_status_rpc(...)` | `select … into v_tz` | 1 скан на виклик |
| `emergency_stop_rpc(uuid[],date,text)` | `select … into v_tz` | 1 скан на виклик |
| `submit_incident_rpc(...)` | `select … into v_tz` | 1 скан на виклик |

`check_no_overlap` і `check_not_in_past` — **рядкові тригери на
`queue_entries`**, тож кожен запис платить щонайменше два скани плюс скан
самої RPC. `queue_reschedule_rpc` успадковує це через тригери. Це
узгоджується з середніми: `queue_set_status_rpc` — 538.9 мс і 684.1 мс,
`queue_reschedule_rpc` — 1043.8 мс і 875.0 мс.

## 6. Чому підзапит узагалі там є (і чому його не можна просто прибрати)

Він не косметичний: він **валідує** назву зони. Якщо `clinics.timezone`
містить сміття, `coalesce(..., 'UTC')` дає падіння назад на UTC замість
помилки `invalid value for parameter "TimeZone"`.

Стан на зараз:

* `clinics`: `Europe/Kiev` (валідна), `UTC` (валідна);
* **CHECK-обмеження на `clinics.timezone` немає** — є тільки
  `clinics_max_cascade_chk`, `clinics_overlap_threshold_chk`,
  `clinics_queue_delay_policy_chk`.

Тобто прибрати перевірку «в лоб» — значить обміняти повільність на падіння
запису при кривій зоні.

## 7. Пропозиція пакета (потребує погодження)

Перенести валідацію з **читання** на **запис**:

1. тригер `before insert or update` на `clinics`, що відхиляє неіснуючу
   назву зони (один скан на зміну клініки — а їх одиниці);
2. у шести функціях замінити підзапит на `coalesce(c.timezone, 'UTC')`
   напряму;
3. окремо — прибрати корельованість у `room_busy_slots` (виклик має бути
   один на запит, не на рядок).

Через те, що це зачіпає **тригери та `SECURITY DEFINER`**, пакет
підпадає під правило двох незалежних раундів рев'ю з різними лінзами,
іменований червоний тест плюс зелена база, і живу перевірку в обидва боки.
Також знадобиться оновлення інваріанта #19 (`guard_fn_bodies`) —
змінюються тіла функцій.
