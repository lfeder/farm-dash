-- Late-cycle resolution for the Lettuce Schedule "Issues" tab (2026-08-29).
--
-- The schedule flags cycles whose expected harvest has passed with no harvest
-- recorded. Each is one of three things: a harvest that happened but was never
-- entered, lettuce genuinely still on the pond, or a plan row that was never
-- really ponded. The Issues tab lets the office resolve each one.
--
-- The dashboard has no login — it talks to Supabase with the public anon key —
-- so instead of granting anon UPDATE on grow_lettuce_seed_batch (the core
-- lettuce table), the write goes through this SECURITY DEFINER function. It can
-- only touch rows that are already flagged as late: hawaii_farming, not
-- deleted, no harvest_date, ponded, expected harvest before today. Every edit
-- stamps updated_by so it is greppable, and each action is reversible
-- (harvest_date/is_deleted were null/false before).

-- The schedule view has to expose the batch id for the tab to address a row.
-- (id is appended LAST: create-or-replace can only add columns at the end.)
create or replace view public.lettuce_schedule_v as
  SELECT
    substring(b.lane, '^(P[0-9]+)') AS pond,
    substring(b.lane, '^P[0-9]+(.+)$') AS side,
    COALESCE(ii.grow_variety_id,
      CASE WHEN b.grow_lettuce_seed_mix_id IS NOT NULL THEN 'MS' ELSE NULL END,
      'NA') AS variety,
    COALESCE(b.invnt_item_id, b.grow_lettuce_seed_mix_id) AS seedname,
    b.seeds_per_unit AS seedsperboard,
    b.number_of_units AS boards,
    b.seeding_date,
    b.transplant_date AS pond_date,
    b.estimated_harvest_date,
    b.harvest_date,
    b.id
  FROM grow_lettuce_seed_batch b
  LEFT JOIN invnt_item ii ON ii.id = b.invnt_item_id AND ii.org_id = b.org_id
  WHERE b.org_id = 'hawaii_farming'
    AND COALESCE(b.is_deleted, false) = false
    AND (EXTRACT(year FROM b.seeding_date) = 2026
      OR EXTRACT(year FROM b.estimated_harvest_date) = 2026
      OR EXTRACT(year FROM b.harvest_date) = 2026);

create or replace function public.lettuce_resolve_late_cycle(
  p_batch_id uuid,
  p_action   text,               -- 'harvested' | 'reschedule' | 'retire'
  p_date     date default null,  -- harvested: cut date; reschedule: new expected date
  p_note     text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Pacific/Honolulu')::date;
  b       grow_lettuce_seed_batch%rowtype;
  v_msg   text;
begin
  -- Eligibility IS the security boundary: only rows the schedule already flags.
  select * into b from grow_lettuce_seed_batch
   where id = p_batch_id
     and org_id = 'hawaii_farming'
     and coalesce(is_deleted, false) = false
     and harvest_date is null
     and estimated_harvest_date is not null
     and estimated_harvest_date < v_today
     and transplant_date is not null
     and transplant_date <= v_today;
  if not found then
    raise exception 'batch % is not an open past-due lettuce cycle', p_batch_id;
  end if;

  if p_action = 'harvested' then
    if p_date is null or p_date > v_today or p_date < b.transplant_date then
      raise exception 'harvest date must fall between the pond date (%) and today (%)',
        b.transplant_date, v_today;
    end if;
    v_msg := 'harvest recorded from the schedule Issues tab';
    update grow_lettuce_seed_batch
       set harvest_date = p_date,
           notes = trim(both E'\n' from coalesce(notes || E'\n', '')
                   || '[' || v_today || ' dash-issues] ' || v_msg
                   || coalesce(' — ' || nullif(trim(p_note), ''), '')),
           updated_at = now(), updated_by = 'dash-issues'
     where id = p_batch_id;

  elsif p_action = 'reschedule' then
    if p_date is null or p_date < v_today or p_date <= b.estimated_harvest_date then
      raise exception 'new expected harvest must be today (%) or later, and after the old one (%)',
        v_today, b.estimated_harvest_date;
    end if;
    v_msg := 'expected harvest pushed ' || b.estimated_harvest_date || ' -> ' || p_date;
    update grow_lettuce_seed_batch
       set estimated_harvest_date = p_date,
           notes = trim(both E'\n' from coalesce(notes || E'\n', '')
                   || '[' || v_today || ' dash-issues] ' || v_msg
                   || coalesce(' — ' || nullif(trim(p_note), ''), '')),
           updated_at = now(), updated_by = 'dash-issues'
     where id = p_batch_id;

  elsif p_action = 'retire' then
    v_msg := 'retired from the schedule Issues tab (never ponded / duplicate)';
    update grow_lettuce_seed_batch
       set is_deleted = true,
           notes = trim(both E'\n' from coalesce(notes || E'\n', '')
                   || '[' || v_today || ' dash-issues] ' || v_msg
                   || coalesce(' — ' || nullif(trim(p_note), ''), '')),
           updated_at = now(), updated_by = 'dash-issues'
     where id = p_batch_id;

  else
    raise exception 'unknown action %', p_action;
  end if;
end $$;

revoke all on function public.lettuce_resolve_late_cycle(uuid, text, date, text) from public;
grant execute on function public.lettuce_resolve_late_cycle(uuid, text, date, text) to anon, authenticated;

comment on function public.lettuce_resolve_late_cycle(uuid, text, date, text) is
  'Lettuce Schedule Issues tab: resolve a past-due unharvested cycle (record the harvest, push the expected date, or retire the row). Only rows already flagged late are eligible; anon may execute.';
