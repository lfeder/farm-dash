-- JTL_05 seed-batch lineage fix — APPLIED to prod 2026-08-08
--
-- PROBLEM
-- JTL_05 had 8 crops (each preceded by a 26-38 day turnaround) but only 6 seed
-- batches. With no batch to attach to, each orphaned crop's harvest was split
-- across its neighbours: the front half charged backwards to the previous batch
-- (ages stretched to day 154) and the rest charged forwards to the next batch
-- (negative ages, down to -15). One crop was even linked to JTL_06's batch.
--
-- On the Cuke Yields plant-age chart this showed as a phantom second hump past
-- week 14 built from 1-2 cycles. Calendar/YoY totals were never affected: the
-- pounds were all present and correctly dated, just mis-parented.
--
-- ROOT CAUSE (two separate defects)
--   1. Batch 2026-01-13 (cycle_code 260106) was filed under site_id 'jtl_06'
--      but belongs to jtl_05. Evidence:
--        - jtl_05 cadence 2025-10-23 -> 2026-01-13 = 82d (house runs ~84d);
--          jtl_06 without it runs 12-31 -> 04-10 = 100d with a phantom between
--        - jtl_06 had 9 batches for 8 crops; it was the only surplus on the farm
--        - jtl_06 has ONE crop (first pick 02-15) spanning both batches
--        - 53 jtl_05 harvest rows already linked here with normal ages (d54-82)
--        - both houses' winter crops then show a 46d seeding->first-pick lag
--          (vs ~36-40d in summer); the alternative forces a 33d winter crop
--          AND leaves the 12-31 batch with no harvest at all
--      Same class of bug as the three cross-house mix-ups retired 2026-08-01
--      from the 2026-07-12 import; this one survived by not being a duplicate.
--   2. The ~2025-05-06 batch was never recorded at all (absent including
--      is_deleted rows). Reconstructed below.
--
-- NOTE: grow_cuke_harvest is a VIEW over grow_harvest_weight. seeding_date,
-- days_since_seed AND variety are all derived from the linked batch — variety
-- comes from batch.invnt_item_id — so every repoint below matches on
-- invnt_item_id to avoid silently changing a row's reported variety.
--
-- INFERRED (only this): the 2025-05-06 seeding date, and that batch's
-- rows/seeds, which were copied from the same house's 2025-02-11 batch.
-- Everything else corrects records that already existed.

-- Backups taken before the change (still present):
--   fix_jtl05_20260808_base_backup     384 rows of grow_harvest_weight
--   fix_jtl05_20260808_batch_backup      3 rows of grow_cuke_seed_batch
--   fix_jtl05_20260808_harvest_backup  384 rows of the view (reference)

-- 1. Move JTL_06's 8 tail rows (Apr 15-19 2026) onto its own 2025-12-31 batch,
--    so re-homing the 01-13 batch doesn't orphan them.
with tgt as (
  select id, invnt_item_id from grow_cuke_seed_batch
  where site_id='jtl_06' and seeding_date='2025-12-31' and is_deleted=false),
src as (
  select h.id, b.invnt_item_id from grow_harvest_weight h
  join grow_cuke_seed_batch b on b.id = h.grow_cuke_seed_batch_id
  where h.gh_site_id='jtl_06' and h.is_deleted=false
    and b.site_id='jtl_06' and b.seeding_date='2026-01-13')
update grow_harvest_weight h
set grow_cuke_seed_batch_id = tgt.id,
    updated_at = now(), updated_by = 'jtl05-lineage-fix-20260808'
from src join tgt on tgt.invnt_item_id = src.invnt_item_id
where h.id = src.id;                                            -- 8 rows

-- 2. Re-home the mis-filed batch to jtl_05 (3 variety rows).
update grow_cuke_seed_batch
set site_id='jtl_05', cycle_code='260105',
    notes = concat_ws(' | ', notes, 'Corrected 2026-08-08: filed as jtl_06 by import; belongs to jtl_05. ...'),
    updated_at = now(), updated_by = 'jtl05-lineage-fix-20260808'
where site_id='jtl_06' and seeding_date='2026-01-13' and is_deleted=false;

-- 3. Crop 5 (2026-02-28..04-05): 112 rows charged backwards to 2025-10-23.
with tgt as (
  select id, invnt_item_id from grow_cuke_seed_batch
  where site_id='jtl_05' and seeding_date='2026-01-13' and is_deleted=false),
src as (
  select h.id, b.invnt_item_id from grow_harvest_weight h
  join grow_cuke_seed_batch b on b.id = h.grow_cuke_seed_batch_id
  where h.gh_site_id='jtl_05' and h.is_deleted=false
    and h.harvest_date between '2026-02-28' and '2026-04-05'
    and b.seeding_date='2025-10-23')
update grow_harvest_weight h
set grow_cuke_seed_batch_id = tgt.id,
    updated_at = now(), updated_by = 'jtl05-lineage-fix-20260808'
from src join tgt on tgt.invnt_item_id = src.invnt_item_id
where h.id = src.id;                                            -- 112 rows

-- 4. Create the never-recorded cycle (J + K only, matching crop 2's varieties).
insert into grow_cuke_seed_batch
  (org_id, farm_id, site_id, invnt_item_id, seeding_date, transplant_date,
   rows_4_per_bag, rows_5_per_bag, seeds, status, cycle_code, created_by, updated_by, notes)
select b.org_id, b.farm_id, 'jtl_05', b.invnt_item_id,
       date '2025-05-06', date '2025-05-20',
       b.rows_4_per_bag, b.rows_5_per_bag, b.seeds, 'Harvested', '250505',
       'jtl05-lineage-fix-20260808', 'jtl05-lineage-fix-20260808',
       'Reconstructed 2026-08-08: ... seeding date INFERRED; rows/seeds COPIED from 2025-02-11 batch - not measured.'
from grow_cuke_seed_batch b
where b.site_id='jtl_05' and b.seeding_date='2025-02-11' and b.is_deleted=false
  and b.invnt_item_id in ('Delta Star Minis(RZ)','F1 TSX-CU235JP(Tokita)');

-- 5. Crop 2 (2025-06-13..07-31): 211 rows split across the 02-11 and 07-31 batches.
with tgt as (
  select id, invnt_item_id from grow_cuke_seed_batch
  where site_id='jtl_05' and seeding_date='2025-05-06' and is_deleted=false),
src as (
  select h.id, b.invnt_item_id from grow_harvest_weight h
  join grow_cuke_seed_batch b on b.id = h.grow_cuke_seed_batch_id
  where h.gh_site_id='jtl_05' and h.is_deleted=false
    and h.harvest_date between '2025-06-13' and '2025-07-31'
    and b.seeding_date in ('2025-02-11','2025-07-31'))
update grow_harvest_weight h
set grow_cuke_seed_batch_id = tgt.id,
    updated_at = now(), updated_by = 'jtl05-lineage-fix-20260808'
from src join tgt on tgt.invnt_item_id = src.invnt_item_id
where h.id = src.id;                                            -- 211 rows

-- VERIFIED AFTER APPLYING
--   JTL_05 now 8 clean cycles, cadence 82-86d, all ages within d33-105
--   pounds conserved exactly on touched rows: 120,367 before = 120,367 after
--   JTL_06 intact: 75,360 lb over 2026-02-15..04-19 (74,477 + 883)
--   farm-wide rows with days_since_seed > 125 ....... 0
--   farm-wide harvest linked to another house's batch  0
--   remaining days_since_seed < 0: 48 rows, BIP_HI Jan-2022 only (pre-existing
--     2022 boundary artifact — crop in progress before the batch table starts)

-- ROLLBACK
-- update grow_harvest_weight h set grow_cuke_seed_batch_id = k.grow_cuke_seed_batch_id
--   from fix_jtl05_20260808_base_backup k where k.id = h.id;
-- update grow_cuke_seed_batch b set site_id=k.site_id, cycle_code=k.cycle_code, notes=k.notes
--   from fix_jtl05_20260808_batch_backup k where k.id = b.id;
-- delete from grow_cuke_seed_batch where cycle_code='250505' and site_id='jtl_05';

-- FOLLOW-UP (not done here): the ETL should reject a harvest->batch link where
-- batch.site_id <> harvest.gh_site_id, and flag ages <0 or >125, which would
-- have caught all three symptoms at import time.
