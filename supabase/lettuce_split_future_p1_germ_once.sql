-- One-time P1 germ-room split (2026-09-04).
--
-- For every eligible *unponded* P1AB batch, retain 1 row / 10 boards on the
-- original batch and move its seed date to two days before ponding.  Create a
-- sibling batch for the remaining rows/boards, seeded one day before ponding.
-- Pond date and estimated harvest date do not change.
--
-- Scope is intentionally narrow and non-recurring:
--   * Hawaii Farming P1AB only
--   * open, non-deleted rows only
--   * original seed date is today or later; pond date is after today in Honolulu
--   * exactly 10 boards per row (the current P1 plan's geometry)
--
-- The archive row is also a run-once guard: rerunning this script does not
-- create a second sibling for a batch already split by it.

begin;

create table if not exists archive.lettuce_p1_germ_split_once (
  original_id uuid primary key,
  sibling_id  uuid not null,
  split_at    timestamptz not null default now(),
  preimage    jsonb not null
);

comment on table archive.lettuce_p1_germ_split_once is
  'One-time 2026-09-04 P1 germ split: original P1 batch becomes 10 boards seeded pond-2; sibling holds the balance seeded pond-1.';

do $split$
declare
  v_today date := (now() at time zone 'Pacific/Honolulu')::date;
  v_tag text := 'p1-germ-split-20260904';
  r grow_lettuce_seed_batch%rowtype;
  v_sibling uuid;
  v_count integer := 0;
  v_bad integer;
begin
  -- Fail rather than silently changing an unexpected P1 geometry.
  select count(*) into v_bad
    from grow_lettuce_seed_batch b
   where b.org_id = 'hawaii_farming'
     and b.lane = 'P1AB'
     and coalesce(b.is_deleted, false) = false
     and b.harvest_date is null
     and b.seeding_date >= v_today
     and b.transplant_date > v_today
     and not exists (select 1 from archive.lettuce_p1_germ_split_once a where a.original_id = b.id)
     and (b.estimated_harvest_date is null
          or b.number_of_units is null
          or b.number_of_units < 20
          or b.number_of_rows is null
          or b.number_of_rows <> b.number_of_units / 10
          or mod(b.number_of_units, 10) <> 0);
  if v_bad <> 0 then
    raise exception 'refusing P1 germ split: % eligible rows are not whole 10-board P1 rows', v_bad;
  end if;

  for r in
    select b.*
      from grow_lettuce_seed_batch b
     where b.org_id = 'hawaii_farming'
       and b.lane = 'P1AB'
       and coalesce(b.is_deleted, false) = false
       and b.harvest_date is null
       and b.seeding_date >= v_today
       and b.transplant_date > v_today
       and b.estimated_harvest_date is not null
       and b.number_of_units >= 20
       and b.number_of_rows = b.number_of_units / 10
       and mod(b.number_of_units, 10) = 0
       and not exists (select 1 from archive.lettuce_p1_germ_split_once a where a.original_id = b.id)
     order by b.transplant_date, b.id
     for update
  loop
    -- The new sibling represents every row except the first. It inherits all
    -- crop/seed/lot metadata, pond date, and harvest date from the original.
    insert into grow_lettuce_seed_batch (
      org_id, farm_id, site_id, lane, grow_cycle_pattern_id, grow_trial_type_id,
      grow_lettuce_seed_mix_id, invnt_item_id, invnt_lot_id, seeding_uom,
      number_of_units, seeds_per_unit, number_of_rows,
      seeding_date, transplant_date, estimated_harvest_date,
      notes, created_by, updated_by
    ) values (
      r.org_id, r.farm_id, r.site_id, r.lane, r.grow_cycle_pattern_id, r.grow_trial_type_id,
      r.grow_lettuce_seed_mix_id, r.invnt_item_id, r.invnt_lot_id, r.seeding_uom,
      r.number_of_units - 10, r.seeds_per_unit, r.number_of_rows - 1,
      r.transplant_date - 1, r.transplant_date, r.estimated_harvest_date,
      trim(both E'\n' from coalesce(r.notes || E'\n', '')
        || '[' || v_tag || '] sibling: remaining ' || (r.number_of_units - 10)
        || ' boards / ' || (r.number_of_rows - 1) || ' rows, seeded pond-1'),
      v_tag, v_tag
    ) returning id into v_sibling;

    insert into archive.lettuce_p1_germ_split_once (original_id, sibling_id, preimage)
      values (r.id, v_sibling, to_jsonb(r));

    -- The original row becomes the one early-germ row.
    update grow_lettuce_seed_batch
       set number_of_units = 10,
           number_of_rows = 1,
           seeding_date = r.transplant_date - 2,
           notes = trim(both E'\n' from coalesce(notes || E'\n', '')
             || '[' || v_tag || '] first 10 boards / 1 row, seeded pond-2; sibling '
             || v_sibling || ' holds the remaining boards seeded pond-1'),
           updated_at = now(),
           updated_by = v_tag
     where id = r.id;
    v_count := v_count + 1;
  end loop;

  raise notice 'P1 germ split completed: % original batches split into % additional batches', v_count, v_count;
end
$split$;

commit;
