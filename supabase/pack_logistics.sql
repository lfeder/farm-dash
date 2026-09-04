-- The logistics schedule, moved out of the Google Sheet.
--
-- Four tables under pack_, because Pack is the department that owns this work:
-- every journey starts at the packhouse, the first lane of the chart is the
-- pack line, and Pack's sub-modules already include Fulfillment. There is no
-- Logistics module in sys_module, so a logi_ prefix would have been the only
-- business-domain prefix in the schema with no department behind it.
--
--   pack_journey        one row per journey  -- the sheet's COLUMNS
--   pack_journey_leg    one row per step     -- the sheet's CELLS
--   pack_freight_gate   somebody else's door and when it opens
--   pack_sailing        which boat goes where, and when
--
-- What deliberately stays in the repo (logistics/src/reference.json): the step
-- order and its place-pair overrides, which are chart rendering config and
-- change when the code changes; and the 6h/48h test-and-hold recipes, which
-- have no good home yet -- fsafe_test_hold is per-event, not a reusable recipe.

-- ── journeys ────────────────────────────────────────────────────────────────
-- Crop, where it is going, what carries it and which hold it runs: the four
-- facts that tell one journey from another, which is why they are also what
-- names it. `id` is a readable slug rather than a uuid so a leg's foreign key
-- says what it points at.
create table if not exists public.pack_journey (
  id             text primary key,
  org_id         text        not null default 'hawaii_farming',
  crop           text        not null,
  fob            text        not null,
  transport      text,
  hold           text,
  -- Which cutting days this journey runs on, as offsets from the first.
  -- '0, 3' is the cut day and again three days later: the barge sails twice a
  -- week and everything is built around it.
  start_days     text        not null default '0, 3',
  -- Turning a journey off is a decision, not a deletion: it stays in the table
  -- with its legs so it can come back without being retyped. This replaces a
  -- hard-coded HIDDEN list in the viewer that needed a deploy to change.
  is_active      boolean     not null default true,
  display_order  smallint,
  notes          text,
  created_at     timestamptz not null default now(),
  created_by     text,
  updated_at     timestamptz not null default now(),
  updated_by     text,
  is_deleted     boolean     not null default false
);

comment on table public.pack_journey is
  'One row per freight journey -- the columns of the old logistics Google Sheet.';

-- ── legs ────────────────────────────────────────────────────────────────────
-- A step of a journey and the window it runs in. The day is stored beside the
-- time because a leg regularly crosses midnight and the day it lands on is the
-- point ("Tue 18:00 - Wed 12:00" is the barge, and Wednesday is the answer).
--
-- Where a step runs BETWEEN is not here: it comes from reference.json, which
-- can vary the pair by transport or by fob. Two journeys' "Load Truck" are the
-- same step at different times, not different steps.
create table if not exists public.pack_journey_leg (
  id               uuid        primary key default gen_random_uuid(),
  org_id           text        not null default 'hawaii_farming',
  pack_journey_id  text        not null references public.pack_journey(id) on delete cascade,
  step             text        not null,
  step_order       smallint,
  -- Branch 1 is the journey itself. Branch 2 is the test-and-hold chain, which
  -- is generated from reference.json rather than typed, so nothing writes it
  -- here -- the column exists because the viewer's row shape has always had it.
  branch           text        not null default '1',
  start_dow        smallint    not null check (start_dow between 0 and 6),
  start_time       time        not null,
  end_dow          smallint    not null check (end_dow between 0 and 6),
  end_time         time        not null,
  notes            text,
  created_at       timestamptz not null default now(),
  created_by       text,
  updated_at       timestamptz not null default now(),
  updated_by       text,
  is_deleted       boolean     not null default false,
  unique (pack_journey_id, step, branch)
);

create index if not exists pack_journey_leg_journey_idx
  on public.pack_journey_leg (pack_journey_id);

comment on table public.pack_journey_leg is
  'One row per step of a journey -- the cells of the old logistics Google Sheet. '
  'Day 0 = Sunday, matching the viewer.';

-- ── gates ───────────────────────────────────────────────────────────────────
-- Only GATES live here: somebody else's door, which opens when they say. Our
-- own places carry no window at all, because the viewer treats a place with no
-- window as one that can never be late -- it is the ABSENCE of a row here, not
-- a value in it, that turns the gating off. So do not add the packhouse.
--
-- `id` is the place name because that is what a leg matches on; there is one
-- namespace for places and this is half of it.
create table if not exists public.pack_freight_gate (
  id             text        primary key,
  org_id         text        not null default 'hawaii_farming',
  -- 'Mon-Fri', 'Sun-Sat' or 'Mon; Wed; Fri'. Kept as the text somebody would
  -- write rather than a seven-element mask, because this is a column people
  -- edit and a mask is not something anyone can read back.
  days           text        not null,
  open_time      time        not null,
  close_time     time        not null,
  is_active      boolean     not null default true,
  display_order  smallint,
  notes          text,
  created_at     timestamptz not null default now(),
  created_by     text,
  updated_at     timestamptz not null default now(),
  updated_by     text,
  is_deleted     boolean     not null default false
);

comment on table public.pack_freight_gate is
  'Third-party receiving facilities and their opening hours. Our own sites do '
  'not belong here -- a place with no row is a place that can never be late.';

-- ── sailings ────────────────────────────────────────────────────────────────
-- Departures and arrivals are stored as the text the carrier publishes ('Tue
-- 18:00', or just 'Mon' where that is all they commit to), because rounding a
-- vague schedule up to a timestamp would be inventing precision we were not
-- given.
create table if not exists public.pack_sailing (
  id             uuid        primary key default gen_random_uuid(),
  org_id         text        not null default 'hawaii_farming',
  route          text        not null,
  departs        text        not null,
  arrives        text,
  connects       text,
  is_active      boolean     not null default true,
  display_order  smallint,
  notes          text,
  created_at     timestamptz not null default now(),
  created_by     text,
  updated_at     timestamptz not null default now(),
  updated_by     text,
  is_deleted     boolean     not null default false
);

comment on table public.pack_sailing is
  'Barge schedule. Times are the carrier''s own text, not timestamps.';

-- ── keeping updated_at honest ───────────────────────────────────────────────
create or replace function public.pack_logistics_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['pack_journey','pack_journey_leg',
                           'pack_freight_gate','pack_sailing'] loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format('create trigger %I_touch before update on public.%I '
                   'for each row execute function public.pack_logistics_touch()', t, t);
  end loop;
end $$;

-- ── access ──────────────────────────────────────────────────────────────────
-- The house pattern is RLS on with policies for `authenticated` scoped by
-- org_id. These four also carry anon policies for every verb, because the
-- dashboards hold only the anon key and the Logistics tab edits the schedule
-- in place. That is a deliberate decision (lennyfeder, 2026-09-03): anyone
-- with the dashboard URL can change the freight schedule, the same tradeoff
-- already accepted for the finance and PO tables on 2026-06-08. Adding
-- Supabase auth to the dashboards is the fix whenever it is wanted.
do $$
declare t text;
begin
  foreach t in array array['pack_journey','pack_journey_leg',
                           'pack_freight_gate','pack_sailing'] loop
    execute format('alter table public.%I enable row level security', t);

    execute format('drop policy if exists %I_auth_all on public.%I', t, t);
    execute format(
      'create policy %I_auth_all on public.%I for all to authenticated '
      'using (org_id in (select get_user_org_ids())) '
      'with check (org_id in (select get_user_org_ids()))', t, t);

    execute format('drop policy if exists %I_anon_all on public.%I', t, t);
    execute format(
      'create policy %I_anon_all on public.%I for all to anon '
      'using (true) with check (true)', t, t);

    execute format('grant select, insert, update, delete on public.%I to anon, authenticated', t);
  end loop;
end $$;
