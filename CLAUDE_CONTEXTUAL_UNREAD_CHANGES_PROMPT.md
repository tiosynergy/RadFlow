# RadFlow — Contextual Unread Change Indicators

You are a senior backend architect, orchestrator using other skills and connectors, database reliability engineer, and Next.js/Supabase developer working on RadFlow.

```
Work directly in the existing project directory:

D:\RadFlowDev
```

RadFlow is a multi-tenant B2B SaaS platform for MRI/CT patient queue automation.

Before making changes, read:

1. `AGENTS.md`
2. `NEXT_SESSION_PROMPT.md`
3. The latest section of `docs/HANDOVER.md`
4. `supabase/migrations/0128_important_events.sql`
5. `lib/importantEvents.ts`
6. `lib/importantEvents.server.ts`
7. `lib/useRealtimeRefetch.ts`

Do not apply migrations to production. The owner applies migrations manually, database first and client second. Do not commit or deploy unless explicitly instructed.

# Objective

Implement a reliable contextual unread-change indication system, referred to as the “red dot” system.

The system must help users notice information changed by another user or role.

Example:

A referrer changes the selected studies/services, patient information, room, date, or time of a referral. The administrator must see a red dot exactly where the updated information is displayed. Once the administrator successfully loads and sees the current version of that information, the unread state must be cleared.

The system must work:

- in real time;
- across browser tabs;
- across computers, tablets, and phones;
- for all RadFlow roles;
- across multiple clinics;
- under Supabase RLS;
- without exposing patient PII.

# Critical UX requirement

Do not implement:

- a global bottom indicator;
- a floating notification button;
- a notification center;
- a global inbox drawer;
- a global unread bell.

All unread indicators must be contextual.

A change must produce indicators through the relevant UI hierarchy:

```text
Changed field/block
    → affected entity/card/row
        → affected section/tab
            → relevant navigation item
```

Examples:

- A referral reschedule:

  - red dot on the Queue navigation item;
  - red dot on the affected queue card;
  - red dot next to the date/time block after the card is expanded.

- A studies/services change:

  - red dot on the affected queue card;
  - red dot next to the “Послуги” block.

- A service catalog change:

  - red dot on the Services navigation item;
  - red dot on the changed service row;
  - if the change is room-specific, a red dot next to the affected room override.

- A waitlist change:

  - red dot on the Waitlist navigation item;
  - red dot on the affected waitlist row.

- A referral access change:

  - red dot on the “Мої центри” tab;
  - red dot on the affected center card.

- A case change:

  - red dot on the relevant case section;
  - red dot on the affected case card or case step.

Parent indicators are derived from unread child events. They must disappear only when no unread child events remain.

# Read acknowledgement semantics

Do not clear unread state merely because the user clicked a navigation item or opened a page.

An event may be marked as seen only when all of the following are true:

1. The relevant page, tab, card, or field block is open.
2. The latest data has been successfully fetched from Supabase.
3. The affected entity and changed information have been rendered.
4. The event belonged to the snapshot that was actually rendered.

If loading fails, unread state must remain unchanged.

For paginated or virtualized lists:

- opening the section must not mark every event as seen;
- only rows that were actually loaded and shown may be acknowledged;
- off-screen or not-yet-loaded rows must remain unread;
- use visibility observation where necessary.

For collapsed cards:

- a card-level change may remain unread until the card is expanded if the changed information is inside the expanded area;
- field-level events must not be cleared while their field block remains hidden.

When marking events as seen, send only the exact event IDs from the rendered snapshot.

A new event arriving after the snapshot must remain unread.

The database update must be idempotent:

```text
seen_at = coalesce(seen_at, database_now)
```

Never accept `seen_at` from the browser as a trusted timestamp.

# Existing architecture and reliability problem

RadFlow already has `important_events` from migration `0128` with:

- 12 `referral.*` event types;
- 20 general event types;
- PII-safe details;
- `actor_id`, `actor_role`, `subject_referrer_id`;
- `entity_type`, `entity_id`, and `changed_fields`.

However, the current `emitImportantEvent()` implementation is fail-open and is usually called after the business mutation has already succeeded.

Therefore, the current implementation cannot guarantee that a cross-role change produces an unread marker.

Do not describe the new system as reliable while keeping all required events as post-operation fail-open writes.

For changes that require a contextual unread marker, the business mutation, important event, and recipient fan-out must be part of the same database transaction or another demonstrably durable pattern.

Prioritize transactional integration for:

- referral creation;
- referral rescheduling;
- referral cancellation;
- referral studies/services changes;
- referral patient-data changes;
- waitlist changes;
- patient case changes;
- service catalog mutations;
- room-specific service overrides;
- access and role changes;
- incidents and emergency stops.

The existing fail-open journal behavior may remain for events that are not part of the contextual unread system.

# Database design

Create the next migration according to the repository convention. Production currently includes migration `0128`; the expected next migration is `0129`.

Create a recipient-specific table such as `public.user_change_markers`.

Recommended columns:

```text
id                     uuid primary key
source_event_id        uuid not null
recipient_id           uuid not null
clinic_id              uuid not null
event_type             text not null
surface_key            text not null
entity_type            text not null
entity_id              uuid not null
field_scope            text
actor_id               uuid
actor_role             text not null
subject_referrer_id    uuid
room_id                uuid
severity               text not null
changed_fields         text[]
details                jsonb
created_at             timestamptz not null
seen_at                timestamptz
```

Use a uniqueness constraint equivalent to:

```text
unique(source_event_id, recipient_id)
```

Do not cascade-delete unread markers when `important_events` retention removes the source journal row. The marker must retain its PII-safe event snapshot independently.

Add indexes for the actual query patterns:

```text
(recipient_id, created_at desc)

(recipient_id, surface_key, created_at desc)

(recipient_id, entity_type, entity_id, created_at desc)

partial:
(recipient_id, surface_key, created_at desc)
where seen_at is null
```

Index all foreign-key columns where applicable.

Retention policy:

- seen markers may be removed after the agreed retention period, initially 180 days;
- unread markers must not be removed by the normal retention job;
- unread age and count must be monitored to detect abandoned accounts or broken acknowledgement flows.

# Surface and field taxonomy

Define a typed, centralized taxonomy.

Suggested `surface_key` values:

```text
queue
waitlist
services
schedule
rooms
referrals
cases
staff
centers
incidents
```

Suggested `field_scope` values:

```text
record
schedule
studies
patient_data
status
priority
catalog
room_override
access
case_step
incident
```

Do not scatter raw string values across React components.

Create TypeScript unions and database constraints from one reviewed list, with tests preventing drift.

# Event coverage

The current `app/services/actions.ts` does not emit important events. Add event coverage for:

```text
service.created
service.updated
service.enabled
service.disabled
service.deleted
service.imported
service.room_override_changed
service.room_override_cleared
```

Add proper entity types for:

```text
service
room
schedule_override
```

Also verify whether the following currently declared events have real emitters:

```text
schedule.exception_confirmed
patient_data.exported
staff.role_changed
```

Do not add event names only to TypeScript unions. Each supported event must have:

- a real emission path;
- recipient-routing tests;
- UI surface mapping;
- human-readable Ukrainian text;
- a PII test.

# Recipient routing

Implement recipient routing in one centralized database function or another single authoritative layer.

Do not duplicate the audience matrix across individual Server Actions.

Always exclude the actor from recipients.

Required routing rules:

## Referrer-originated changes

For referral creation, rescheduling, cancellation, patient-data changes, studies changes, waitlist changes, and case changes:

- notify administrators of the clinic;
- notify registrars of the clinic;
- notify radiologists assigned to the affected room only when the change is relevant to execution in that room.

## Clinic-originated changes to a referral

If an event has `subject_referrer_id` and the actor is clinic staff:

- notify the specific referrer;
- the marker must remain visible even if the action revoked that referrer’s clinic access.

## Service, room, and schedule changes

- notify registrars when the operational catalog changes;
- notify radiologists only for rooms assigned to them;
- notify referrers only when the change affects a clinic or room they are authorized to use;
- avoid broadcasting every catalog change to unrelated referrers.

## Radiologist-originated changes

For clinically or operationally important changes:

- notify administrators;
- notify registrars;
- notify the associated referrer where applicable.

Routine `waiting` and `in_progress` status transitions should not create red dots because they are already visible on realtime boards.

Define explicitly whether `done` is informational or unread-worthy. Do not enable it by accident.

## Incidents

- notify clinic staff except the actor;
- notify CEO recipients only for critical incidents and emergency stops;
- restrict radiologist recipients by room when possible.

## Access and role changes

- notify the affected user;
- notify clinic administrators;
- notify CEO recipients only for governance-relevant changes.

# Deleted entities

Because there is no global notification center, deleted entities require a contextual tombstone.

Examples:

- a deleted service must leave a temporary PII-safe row in the Services section describing that a service was removed;
- revoked clinic access must leave a contextual card in “Мої центри” until viewed;
- a removed waitlist item must leave an inline change entry in the Waitlist section.

The tombstone must disappear after its corresponding event is acknowledged.

Do not make deleted-object notifications permanently inaccessible just because the original row no longer exists.

# RLS and privileges

Enable RLS on the marker table.

Recipients may select only their own rows:

```sql
to authenticated
using ((select auth.uid()) = recipient_id)
```

If direct updates are allowed, UPDATE must have both `USING` and `WITH CHECK`, and the client must be restricted to the `seen_at` column.

Clients must not be able to:

- insert markers;
- delete markers;
- change `recipient_id`;
- change event contents;
- acknowledge markers belonging to another user;
- reset someone else’s `seen_at`.

Prefer a carefully scoped server operation or RPC that:

- derives the user from `auth.uid()`;
- accepts only marker IDs;
- sets database time;
- is idempotent;
- returns the IDs actually updated.

Prefer `SECURITY INVOKER`. If `SECURITY DEFINER` is genuinely required, place the function in a non-exposed schema, set an empty or explicit safe `search_path`, validate `auth.uid()`, and revoke default `PUBLIC` execution.

Add explicit grants because Data API exposure and RLS are separate concerns.

# Realtime and reconciliation

Add only the recipient marker table to the `supabase_realtime` publication. Do not expose `important_events` to all roles.

Subscribe with:

```text
recipient_id = current authenticated user
```

The database remains the source of truth. Realtime is only a low-latency signal.

The client must refetch:

- on initial mount;
- after every successful `SUBSCRIBED`, including reconnection;
- after auth token refresh;
- when the page becomes visible;
- when the window regains focus;
- through a low-frequency reconciliation fallback appropriate for this small table.

Fix or account for the current reconnect gap in `lib/useRealtimeRefetch.ts`, where returning to `SUBSCRIBED` stops polling without immediately reconciling changes that may have occurred during the disconnect.

Do not replace a known unread state with zero when a network request fails.

Use explicit state such as:

```text
loading
ready
error-with-previous-data
```

# Client architecture

Implement one shared unread-change data layer, for example:

```text
useUnreadChanges()
UnreadChangesProvider
```

It should perform one batched query and expose indexed selectors such as:

```text
hasUnreadSurface(surfaceKey)
hasUnreadEntity(entityType, entityId)
hasUnreadField(entityType, entityId, fieldScope)

unreadForSurface(surfaceKey)
unreadForEntity(entityType, entityId)
unreadForField(entityType, entityId, fieldScope)
```

Avoid one Supabase query per row or card.

Integrate contextual markers into the existing UI, including where applicable:

- `components/Sidebar.tsx`
- `components/ReferrerSidebar.tsx`
- the radiologist sidebar in `components/RadiologistBoard.tsx`
- `components/QueueBoard.tsx`
- `components/ReferralPortal.tsx`
- `components/ServicesManager.tsx`
- `components/WaitlistBoard.tsx`
- case-related components
- staff/access management components

Do not add a marker component to `app/layout.tsx` as a global floating UI.

# Accessibility and visual behavior

The red dot must not communicate state through color alone.

Provide:

- an accessible label with the unread count or description;
- a non-color indicator such as a glyph or visually hidden text;
- keyboard-accessible expansion of cards and sections;
- an `aria-live` update for newly arrived relevant changes;
- WCAG 2.2 AA contrast;
- correct mobile reflow at 320px.

Use the existing RadFlow CSS system in `styles/prototype/*.css`. Do not introduce Tailwind styling.

UI copy must be Ukrainian.

Suggested labels:

```text
“Є непрочитані зміни”
“Змінено іншим користувачем”
“Оновлення переглянуто”
“Не вдалося завантажити актуальні дані”
```

# Privacy

Markers must remain PII-safe.

Do not store in marker payloads:

- patient name;
- phone;
- email;
- date of birth;
- contraindications;
- notes;
- weight;
- full studies payload;
- arbitrary user-provided text.

Store only:

- entity IDs;
- clinic and room IDs;
- event type;
- changed field names;
- status codes;
- dates/times where already allowed;
- counts;
- controlled enum values.

Reuse and extend the existing recursive PII guard.

The marker itself may say that patient data changed, but it must not contain the patient data.

# Race conditions to handle

Cover these scenarios:

1. A user opens a card while a new event arrives.

   - Only the rendered snapshot is acknowledged.
   - The new event remains unread.

2. Two tabs acknowledge the same event.

   - Both operations succeed idempotently.
   - `seen_at` preserves the first database timestamp.

3. One device acknowledges an event.

   - Other devices clear the same contextual indicators through Realtime.

4. Realtime disconnects briefly.

   - Reconnection immediately refetches and finds missed events.

5. The entity was deleted.

   - A contextual tombstone remains available until viewed.

6. The data refresh fails.

   - No event is acknowledged.

7. The user changes clinic or room filters.

   - Hidden rows are not acknowledged.

8. A bulk operation changes many services.

   - Avoid uncontrolled notification fan-out.
   - Preserve each affected entity where individual review matters, or create a reviewed batch event with explicit scope.

# Testing requirements

Add pure unit tests for:

- event-to-surface mapping;
- event-to-field mapping;
- recipient routing;
- actor exclusion;
- parent indicator aggregation;
- snapshot acknowledgement;
- events arriving during acknowledgement;
- PII rejection;
- deleted-entity tombstones;
- batch event behavior.

Add SQL smoke tests for:

- all five roles;
- two separate clinics;
- referrer cross-clinic access;
- radiologist room scope;
- CEO access scope;
- recipient-only SELECT;
- unauthorized INSERT;
- unauthorized DELETE;
- unauthorized UPDATE;
- attempts to acknowledge another user’s marker;
- cross-tenant isolation;
- revoked referrer receiving and reading their access-revocation marker.

Verify indexes with representative unread queries.

After implementation, run:

```text
npm run typecheck
npm run lint
npm test
npm run build
npm run audit:contrast
```

Perform live verification with two accounts in separate browser contexts:

1. Referrer changes studies.
2. Administrator receives contextual dots on the Queue section, card, and studies block.
3. Administrator opens the card and successfully loads the current data.
4. Only the corresponding studies event is acknowledged.
5. All related dots disappear on every administrator device.
6. A later change immediately creates new dots.
7. No global bottom indicator or notification center exists.

# Deliverables

Provide:

1. Migration and rollback instructions.
2. Updated Supabase TypeScript types.
3. Transactional event/fan-out implementation.
4. Contextual unread hooks and components.
5. Integration into all affected role-specific screens.
6. Unit and SQL smoke tests.
7. A concise mapping document listing:
   - event type;
   - recipients;
   - surface;
   - entity;
   - field scope;
   - acknowledgement condition.
8. Verification results.
9. Remaining risks or workflows that still use fail-open emission.

Do not claim completion if any cross-role workflow can change visible information without producing either a transactional marker or an explicitly documented fallback.
