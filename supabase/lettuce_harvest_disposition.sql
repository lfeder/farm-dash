-- Dumped lettuce: a batch that was grown and pulled but never sold (2026-08-29).
--
-- Until now the schedule offered no honest way to record this. Writing a
-- harvest_date with no weight collides with an existing meaning — cut, weight
-- not entered yet (200 legacy rows look exactly like that) — and it lands
-- badly downstream: the yield page drops weightless rows entirely (so the loss
-- is invisible AND the boards leave the denominator), while the daily page
-- includes them at zero pounds and quietly drags the day's lb/board average
-- down. Marking the row is_deleted is worse: it erases boards that really did
-- occupy the pond.
--
-- So the disposition is explicit. harvest_date is the day the boards were
-- pulled (the pond map clears on it, as always), the weights are zero because
-- that is what came off, and harvest_disposition says why. NULL disposition =
-- the normal case, sold. The vocabulary matches the post-pack side, where
-- discarded product already goes out as a PO to the Trash / Donation customer
-- groups (see finance_po_fill_v).

alter table public.grow_lettuce_seed_batch
  add column if not exists harvest_disposition        text,
  add column if not exists harvest_disposition_reason text;

comment on column public.grow_lettuce_seed_batch.harvest_disposition is
  'NULL = harvested and sold as normal. Dumped = pulled and thrown away. Donation = given away. Set together with harvest_date (the day the boards were pulled) and zero weights.';
comment on column public.grow_lettuce_seed_batch.harvest_disposition_reason is
  'Why the batch was not sold — mildew, bolted, no order, quality, etc. Free text; the dashboard offers a short list.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'grow_lettuce_seed_batch_disposition_ck') then
    alter table public.grow_lettuce_seed_batch
      add constraint grow_lettuce_seed_batch_disposition_ck
      check (harvest_disposition is null
             or (harvest_disposition in ('Dumped', 'Donation') and harvest_date is not null));
  end if;
end $$;

-- Expose it everywhere the batch is read. Appended LAST in each view:
-- create-or-replace can only add columns at the end.
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
    b.id,
    b.harvest_disposition,
    b.harvest_disposition_reason
  FROM grow_lettuce_seed_batch b
  LEFT JOIN invnt_item ii ON ii.id = b.invnt_item_id AND ii.org_id = b.org_id
  WHERE b.org_id = 'hawaii_farming'
    AND COALESCE(b.is_deleted, false) = false
    AND (EXTRACT(year FROM b.seeding_date) = 2026
      OR EXTRACT(year FROM b.estimated_harvest_date) = 2026
      OR EXTRACT(year FROM b.harvest_date) = 2026);

create or replace view public.grow_lettuce_gh_harvest_v as
  SELECT id, org_id, farm_id, harvest_date,
    substring(lane, '^(P[0-9]+)') AS pond,
    substring(lane, '^P[0-9]+(.+)$') AS side,
    COALESCE(invnt_item_id, grow_lettuce_seed_mix_id) AS seed_name,
    number_of_units AS boards_per_pond,
    lb_per_board AS pounds_per_board,
    number_of_units::numeric * lb_per_board AS greenhouse_net_weight,
    max_lb,
    harvest_disposition,
    harvest_disposition_reason
  FROM grow_lettuce_seed_batch b
  WHERE is_deleted = false AND harvest_date IS NOT NULL;

-- The Issues tab gains a fourth resolution: the crop was pulled, not sold.
create or replace function public.lettuce_resolve_late_cycle(
  p_batch_id uuid,
  p_action   text,               -- 'harvested' | 'reschedule' | 'retire' | 'dumped' | 'donated'
  p_date     date default null,  -- harvested/dumped/donated: the day the boards came off
                                 -- reschedule: the new expected harvest date
  p_note     text default null   -- dumped/donated: the reason; otherwise a free note
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Pacific/Honolulu')::date;
  b       grow_lettuce_seed_batch%rowtype;
  v_msg   text;
  v_disp  text;
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

  if p_action in ('harvested', 'dumped', 'donated') then
    if p_date is null or p_date > v_today or p_date < b.transplant_date then
      raise exception 'date must fall between the pond date (%) and today (%)',
        b.transplant_date, v_today;
    end if;
  end if;

  if p_action = 'harvested' then
    v_msg := 'harvest recorded from the schedule Issues tab';
    update grow_lettuce_seed_batch
       set harvest_date = p_date,
           notes = trim(both E'\n' from coalesce(notes || E'\n', '')
                   || '[' || v_today || ' dash-issues] ' || v_msg
                   || coalesce(' — ' || nullif(trim(p_note), ''), '')),
           updated_at = now(), updated_by = 'dash-issues'
     where id = p_batch_id;

  elsif p_action in ('dumped', 'donated') then
    -- Pulled but not sold. harvest_date so the pond clears on the right day,
    -- zero weights because zero pounds is what the boards produced, and the
    -- disposition so no dashboard has to guess which kind of row this is.
    if p_action = 'dumped' and nullif(trim(coalesce(p_note, '')), '') is null then
      raise exception 'a dumped batch needs a reason';
    end if;
    v_disp := case when p_action = 'dumped' then 'Dumped' else 'Donation' end;
    v_msg  := lower(v_disp) || ' — pulled ' || p_date || ', not sold';
    update grow_lettuce_seed_batch
       set harvest_date = p_date,
           harvest_disposition = v_disp,
           harvest_disposition_reason = nullif(trim(coalesce(p_note, '')), ''),
           lb_per_board = 0, max_lb = 0,
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

-- The yield page reads this one (it carries harvest_days, which the harvest
-- view drops), so it needs the disposition too.
create or replace view public.grow_lettuce_seed_batch_v as
  SELECT b.id, b.org_id, b.farm_id, b.site_id, b.ops_task_tracker_id, b.lane,
    b.grow_cycle_pattern_id, b.grow_trial_type_id, b.grow_lettuce_seed_mix_id,
    b.invnt_item_id, b.invnt_lot_id, b.seeding_uom, b.number_of_units,
    b.seeds_per_unit, b.number_of_rows, b.seeding_date, b.transplant_date,
    b.estimated_harvest_date, b.notes, b.created_at, b.created_by, b.updated_at,
    b.updated_by, b.is_deleted, b.height_mm, b.lb_per_board, b.final_photo_path,
    b.mildew, b.source_entry_id, b.harvest_date, b.max_lb,
    regexp_replace(b.lane, '^(P[0-9]+)(.+)$', '\1:\2') AS pond_side,
    COALESCE(ii.grow_variety_id,
      CASE WHEN b.grow_lettuce_seed_mix_id IS NOT NULL THEN 'MS' ELSE NULL END,
      'NA') AS variety_abbrev,
    COALESCE(b.invnt_item_id, b.grow_lettuce_seed_mix_id) AS seed_display,
    COALESCE(b.harvest_date, b.estimated_harvest_date) - b.transplant_date AS harvest_days,
    COALESCE((SELECT NULLIF(TRIM(BOTH FROM (e.first_name || ' ') || e.last_name), '')
                FROM hr_employee e
               WHERE e.company_email = b.updated_by AND e.org_id = b.org_id
               ORDER BY e.is_deleted LIMIT 1), b.updated_by) AS reported_by,
    b.updated_at AS reported_at,
    gvr.name AS variety_name,
    b.harvest_disposition,
    b.harvest_disposition_reason
  FROM grow_lettuce_seed_batch b
  LEFT JOIN invnt_item ii ON ii.id = b.invnt_item_id AND ii.org_id = b.org_id
  LEFT JOIN grow_variety gvr ON gvr.id = COALESCE(ii.grow_variety_id,
      CASE WHEN b.grow_lettuce_seed_mix_id IS NOT NULL THEN 'MS' ELSE NULL END, 'NA')
    AND gvr.org_id = b.org_id AND gvr.is_deleted = false;
