-- lettuce-sched Builder → production.
--
-- The Builder used to be read-only: it generated a plan and you pasted / hand-applied
-- it (see the 2026-08-06 08/09 transition, done by hand in SQL). This is that apply,
-- as one transaction the dashboard can call, with a pre-image so it can be undone.
--
-- Security model (same as lettuce_resolve_late_cycle): the dashboards carry the public
-- anon key in page source, so the eligibility check IS the boundary. This function
-- never touches a harvested row, never moves a harvest into the past, never deletes a
-- cycle that is already on the pond, and only writes rows in hawaii_farming.
--
-- A plan is three parts:
--   edits    — existing cycles whose boards get split across harvest events
--   clear    — future planned cycles the plan replaces (soft-deleted)
--   inserts  — the generated cycles
--
-- Rollback: public.lettuce_rollback_plan(run_id).

create table if not exists archive.lettuce_plan_apply (
  run_id         uuid primary key default gen_random_uuid(),
  applied_at     timestamptz not null default now(),
  tag            text not null,
  label          text,
  plan           jsonb not null,   -- payload as sent by the dashboard
  preimage       jsonb not null,   -- every pre-existing row the run touched, as it was
  result         jsonb,
  rolled_back_at timestamptz
);
comment on table archive.lettuce_plan_apply is
  'Pre-image + payload for each lettuce-sched Builder "Apply plan to production" run '
  '(public.lettuce_apply_plan). Undo a run with public.lettuce_rollback_plan(run_id). '
  'A row is safe to drop once the plan window''s last harvest date has passed.';

create index if not exists lettuce_plan_apply_applied_idx
  on archive.lettuce_plan_apply (applied_at desc);

create or replace function public.lettuce_apply_plan(p_plan jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_today   date := (now() at time zone 'Pacific/Honolulu')::date;
  v_start   date := nullif(p_plan->>'start', '')::date;
  v_label   text := nullif(trim(coalesce(p_plan->>'label', '')), '');
  v_edits   jsonb := coalesce(p_plan->'edits',   '[]'::jsonb);
  v_clear   jsonb := coalesce(p_plan->'clear',   '[]'::jsonb);
  v_ins     jsonb := coalesce(p_plan->'inserts', '[]'::jsonb);
  v_run     uuid := gen_random_uuid();
  v_tag     text := 'dash-plan-' || to_char(now() at time zone 'Pacific/Honolulu', 'YYYYMMDD-HH24MI');
  v_stamp   text;
  v_pre     jsonb;
  v_ids     uuid[];
  b         grow_lettuce_seed_batch%rowtype;
  e         jsonb;
  ch        jsonb;
  r         jsonb;
  v_sum     int;
  v_keep_i  int;
  v_i       int;
  v_units   int;
  v_rows    int;
  v_date    date;
  v_lane    text;
  v_site    text;
  v_item    text;
  v_mix     text;
  v_lot     text;
  v_n_edit  int := 0;
  v_n_split int := 0;
  v_n_clear int := 0;
  v_n_ins   int := 0;
begin
  v_stamp := '[' || v_today || ' ' || v_tag || ']';

  if v_start is null then
    raise exception 'the plan needs a start date';
  end if;
  if jsonb_array_length(v_edits) + jsonb_array_length(v_clear) + jsonb_array_length(v_ins) = 0 then
    raise exception 'this plan has nothing to apply';
  end if;
  -- Size caps: a whole-farm 26-week plan is ~900 rows. Anything past this is a bug
  -- or an abuse of the anon key, not a schedule.
  if jsonb_array_length(v_edits) > 400 or jsonb_array_length(v_clear) > 1500 or jsonb_array_length(v_ins) > 1200 then
    raise exception 'plan too large (% edits, % replaced, % new) — generate a shorter window',
      jsonb_array_length(v_edits), jsonb_array_length(v_clear), jsonb_array_length(v_ins);
  end if;

  -- ── Pre-image first: every row this run will change, exactly as it stands now.
  select array_agg(distinct x) into v_ids from (
    select (value->>'id')::uuid  as x from jsonb_array_elements(v_edits)
    union all
    select (value #>> '{}')::uuid     from jsonb_array_elements(v_clear)
  ) s;
  select coalesce(jsonb_agg(to_jsonb(g)), '[]'::jsonb) into v_pre
    from grow_lettuce_seed_batch g
   where g.id = any(coalesce(v_ids, '{}'::uuid[]));

  insert into archive.lettuce_plan_apply (run_id, tag, label, plan, preimage)
       values (v_run, v_tag, v_label, p_plan, v_pre);

  -- ── Part A: split edits on existing cycles.
  -- Each edit hands the whole cohort back as chunks: the boards must still add up,
  -- so a split can never invent or lose boards. The chunk that stays on the original
  -- harvest date keeps the original row; the rest become sibling rows.
  for e in select value from jsonb_array_elements(v_edits) loop
    select * into b from grow_lettuce_seed_batch
     where id = (e->>'id')::uuid
       and org_id = 'hawaii_farming'
       and coalesce(is_deleted, false) = false
       and harvest_date is null
     for update;
    if not found then
      raise exception 'cycle % is not an open unharvested lettuce row', e->>'id';
    end if;

    select coalesce(sum((value->>'boards')::int), 0) into v_sum
      from jsonb_array_elements(e->'chunks');
    if v_sum <> b.number_of_units then
      raise exception 'split of % moves % boards but the cycle holds %', b.id, v_sum, b.number_of_units;
    end if;

    for ch in select value from jsonb_array_elements(e->'chunks') loop
      v_date := (ch->>'date')::date;
      if (ch->>'boards')::int <= 0 then
        raise exception 'split of % has a piece with no boards', b.id;
      end if;
      -- Never move a harvest into the past. A row that is ALREADY past due may keep
      -- its own date (that is the Issues tab's business, not the Builder's).
      if v_date < least(v_today, b.estimated_harvest_date) then
        raise exception 'harvest % is in the past', v_date;
      end if;
      if v_date < b.transplant_date + 7 or v_date > b.transplant_date + 75 then
        raise exception 'harvest % is not a plausible cycle for a pond date of %', v_date, b.transplant_date;
      end if;
    end loop;

    -- Which piece keeps the original row: the one still on the original date, else
    -- the earliest. Everything else is inserted alongside it.
    select idx into v_keep_i from (
      select ordinality as idx,
             ((value->>'date')::date = b.estimated_harvest_date) as is_orig,
             (value->>'date')::date as d
        from jsonb_array_elements(e->'chunks') with ordinality
    ) s order by is_orig desc, d asc limit 1;

    v_i := 0;
    for ch in select value from jsonb_array_elements(e->'chunks') loop
      v_i := v_i + 1;
      v_units := (ch->>'boards')::int;
      v_date  := (ch->>'date')::date;
      -- Rows scale with boards so boards-per-row (the lane width) is preserved.
      v_rows  := greatest(1, round(v_units::numeric
                   * coalesce(b.number_of_rows, b.number_of_units)
                   / nullif(b.number_of_units, 0))::int);
      if v_i = v_keep_i then
        update grow_lettuce_seed_batch
           set number_of_units = v_units,
               number_of_rows  = v_rows,
               estimated_harvest_date = v_date,
               notes = trim(both E'\n' from coalesce(notes || E'\n', '')
                       || v_stamp || ' builder plan: '
                       || case when v_date = b.estimated_harvest_date
                               then v_units || ' of ' || b.number_of_units || ' boards stay on ' || v_date
                               else 'harvest moved ' || b.estimated_harvest_date || ' -> ' || v_date end),
               updated_at = now(), updated_by = v_tag
         where id = b.id;
        v_n_edit := v_n_edit + 1;
      else
        insert into grow_lettuce_seed_batch (
          org_id, farm_id, site_id, lane, grow_cycle_pattern_id, grow_trial_type_id,
          grow_lettuce_seed_mix_id, invnt_item_id, invnt_lot_id, seeding_uom,
          number_of_units, seeds_per_unit, number_of_rows,
          seeding_date, transplant_date, estimated_harvest_date,
          notes, created_by, updated_by)
        values (
          b.org_id, b.farm_id, b.site_id, b.lane, b.grow_cycle_pattern_id, b.grow_trial_type_id,
          b.grow_lettuce_seed_mix_id, b.invnt_item_id, b.invnt_lot_id, b.seeding_uom,
          v_units, b.seeds_per_unit, v_rows,
          b.seeding_date, b.transplant_date, v_date,
          v_stamp || ' builder plan: ' || v_units || ' boards split off ' || b.id
            || ', harvesting ' || v_date || ' instead of ' || b.estimated_harvest_date,
          v_tag, v_tag);
        v_n_split := v_n_split + 1;
      end if;
    end loop;
  end loop;

  -- ── Part B: retire the planned cycles this plan replaces. Soft delete only, and
  -- only rows that have not been ponded yet — the plan assumed they were gone.
  for r in select value from jsonb_array_elements(v_clear) loop
    update grow_lettuce_seed_batch
       set is_deleted = true,
           notes = trim(both E'\n' from coalesce(notes || E'\n', '')
                   || v_stamp || ' replaced by the builder plan starting ' || v_start),
           updated_at = now(), updated_by = v_tag || '-del'
     where id = (r #>> '{}')::uuid
       and org_id = 'hawaii_farming'
       and coalesce(is_deleted, false) = false
       and harvest_date is null
       and transplant_date >= greatest(v_start, v_today);
    if not found then
      raise exception 'cycle % cannot be replaced: it is harvested, already deleted, or already on the pond',
        r #>> '{}';
    end if;
    v_n_clear := v_n_clear + 1;
  end loop;

  -- ── Part C: the generated cycles.
  for r in select value from jsonb_array_elements(v_ins) loop
    v_lane  := upper(trim(coalesce(r->>'lane', '')));
    if v_lane !~ '^P[1-7](AB|A|B|C)$' then
      raise exception 'unknown lane %', v_lane;
    end if;
    v_site  := 'lettuce_gh_' || lower(substring(v_lane from '^P[1-7]'));
    v_units := (r->>'boards')::int;
    v_rows  := greatest(1, round((r->>'rows')::numeric)::int);
    v_date  := (r->>'pond_date')::date;
    if v_units <= 0 or v_units > 2200 then
      raise exception '% boards is not a plausible cycle for %', v_units, v_lane;
    end if;
    if v_date < v_today then
      raise exception 'the plan ponds % on %, which is in the past', v_lane, v_date;
    end if;
    if v_date > v_today + 400 then
      raise exception 'the plan ponds % on %, more than a year out', v_lane, v_date;
    end if;
    if (r->>'harv_date')::date <= v_date or (r->>'harv_date')::date > v_date + 75 then
      raise exception '% pond % -> harvest % is not a plausible cycle', v_lane, v_date, r->>'harv_date';
    end if;
    if (r->>'seed_date')::date > v_date or (r->>'seed_date')::date < v_date - 14 then
      raise exception '% seeding % does not sit just before pond date %', v_lane, r->>'seed_date', v_date;
    end if;

    -- Seed name is either a mix or an inventory item; a lot only exists for items.
    v_mix := null; v_item := null; v_lot := null;
    select id into v_mix from grow_lettuce_seed_mix
     where org_id = 'hawaii_farming' and id = r->>'seed_name' and coalesce(is_deleted, false) = false;
    if v_mix is null then
      select id into v_item from invnt_item
       where org_id = 'hawaii_farming' and id = r->>'seed_name' and coalesce(is_deleted, false) = false;
      if v_item is null then
        raise exception 'seed "%" is neither a seed mix nor an inventory item', r->>'seed_name';
      end if;
      if nullif(trim(coalesce(r->>'lot', '')), '') is not null then
        select id into v_lot from invnt_lot
         where org_id = 'hawaii_farming' and invnt_item_id = v_item and lot_number = r->>'lot'
           and coalesce(is_deleted, false) = false;
        if v_lot is null then
          raise exception 'lot "%" is not an active lot of %', r->>'lot', v_item;
        end if;
      end if;
    end if;

    insert into grow_lettuce_seed_batch (
      org_id, farm_id, site_id, lane, grow_cycle_pattern_id,
      grow_lettuce_seed_mix_id, invnt_item_id, invnt_lot_id, seeding_uom,
      number_of_units, seeds_per_unit, number_of_rows,
      seeding_date, transplant_date, estimated_harvest_date,
      notes, created_by, updated_by)
    values (
      'hawaii_farming', 'Lettuce', v_site, v_lane, nullif(r->>'pattern', ''),
      v_mix, v_item, v_lot, 'BRD',
      v_units, greatest(0, coalesce((r->>'dens')::int, 0)), v_rows,
      (r->>'seed_date')::date, v_date, (r->>'harv_date')::date,
      v_stamp || ' builder plan ' || v_start || coalesce(' — ' || v_label, ''),
      v_tag, v_tag);
    v_n_ins := v_n_ins + 1;
  end loop;

  update archive.lettuce_plan_apply
     set result = jsonb_build_object('edited', v_n_edit, 'split_rows', v_n_split,
                                     'replaced', v_n_clear, 'inserted', v_n_ins)
   where run_id = v_run;

  return jsonb_build_object('run_id', v_run, 'tag', v_tag, 'edited', v_n_edit,
                            'split_rows', v_n_split, 'replaced', v_n_clear, 'inserted', v_n_ins);
end
$function$;

-- Undo one apply: drop what it created, put back what it changed. Rows harvested
-- since the apply are left alone (a real cut always wins over a plan).
create or replace function public.lettuce_rollback_plan(p_run uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  a         archive.lettuce_plan_apply%rowtype;
  r         jsonb;
  v_today   date := (now() at time zone 'Pacific/Honolulu')::date;
  v_deleted int := 0;
  v_restored int := 0;
  v_skipped int := 0;
begin
  select * into a from archive.lettuce_plan_apply where run_id = p_run;
  if not found then
    raise exception 'no plan apply with id %', p_run;
  end if;
  if a.rolled_back_at is not null then
    raise exception 'that apply was already rolled back on %', a.rolled_back_at;
  end if;

  -- Rows the run created and nobody has harvested: they never existed before it.
  delete from grow_lettuce_seed_batch
   where created_by = a.tag and org_id = 'hawaii_farming' and harvest_date is null;
  get diagnostics v_deleted = row_count;

  for r in select value from jsonb_array_elements(a.preimage) loop
    update grow_lettuce_seed_batch
       set number_of_units = (r->>'number_of_units')::int,
           number_of_rows  = nullif(r->>'number_of_rows', '')::int,
           estimated_harvest_date = (r->>'estimated_harvest_date')::date,
           is_deleted = coalesce((r->>'is_deleted')::boolean, false),
           notes = nullif(r->>'notes', ''),
           updated_at = now(), updated_by = a.tag || '-rollback'
     where id = (r->>'id')::uuid
       and harvest_date is null;
    if found then v_restored := v_restored + 1; else v_skipped := v_skipped + 1; end if;
  end loop;

  update archive.lettuce_plan_apply
     set rolled_back_at = now(),
         result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
           'rolled_back', jsonb_build_object('at', v_today, 'deleted', v_deleted,
                                             'restored', v_restored, 'skipped', v_skipped))
   where run_id = p_run;

  return jsonb_build_object('run_id', p_run, 'deleted', v_deleted,
                            'restored', v_restored, 'skipped_harvested', v_skipped);
end
$function$;

revoke all on function public.lettuce_apply_plan(jsonb)    from public;
revoke all on function public.lettuce_rollback_plan(uuid)  from public;
grant execute on function public.lettuce_apply_plan(jsonb)   to anon, authenticated, service_role;
grant execute on function public.lettuce_rollback_plan(uuid) to anon, authenticated, service_role;
