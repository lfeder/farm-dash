-- ============================================================================
-- Cuke seed-batch lineage cleanup — IDEMPOTENT, safe to re-run any number of times
-- ============================================================================
-- Re-run this AFTER the upstream migration/sync is switched off (planned
-- 2026-08-09). While the sync is live it re-creates the mis-filed jtl_06 batch
-- ~1 hour after any correction (observed: fix at 04:24Z, re-inserted 05:37Z
-- with fresh ids), so the cleanup will not stick until the sync stops.
--
-- WHAT IT FIXES
--  A. JTL_05 had 8 crops but 6 seed batches. Orphaned crops' harvest was split
--     across neighbouring batches -> ages of 154d and -15d.
--       A1. batch 2026-01-13 was filed as jtl_06 but belongs to jtl_05
--       A2. the ~2025-05-06 batch was never recorded at all
--  B. BIP_HK Nov 8-9 2024 rows were charged to the 2024-07-11 batch, giving a
--     physically impossible 121-day crop that overlapped the next transplant
--     by 24 days. They belong to 2024-10-02 (ages 37-38).
--
-- IDEMPOTENCY: every statement is guarded so a second run is a no-op.
--   - repoints match on the WRONG batch date, so once moved they stop matching
--   - the batch insert is guarded by NOT EXISTS
--   - the re-home is split: rename only if no jtl_05 twin exists, else retire
--     the duplicate (this is what makes repeated sync re-inserts self-healing)
--
-- NOTE: grow_cuke_harvest is a VIEW. All writes go to grow_harvest_weight.
-- variety is derived from batch.invnt_item_id, so every repoint joins on the
-- item to avoid silently changing a row's reported variety.
-- ============================================================================

\set ON_ERROR_STOP on
begin;

-- ---------------------------------------------------------------- A1 ------
-- The mis-filed 2026-01-13 batch. Two cases:
--   (i)  no jtl_05 twin yet  -> rename jtl_06 rows to jtl_05  (first run)
--   (ii) jtl_05 twin exists  -> retire the jtl_06 rows as duplicates
--                               (every run after a sync re-insert)

-- (i) first-time rename
update grow_cuke_seed_batch b
set site_id='jtl_05', cycle_code='260105',
    notes = concat_ws(' | ', notes,
      'Corrected 2026-08-08: filed as jtl_06 by import; belongs to jtl_05. '
      'Evidence: jtl_05 cadence 2025-10-23->2026-01-13 = 82d (house runs ~84d); '
      'jtl_06 had 9 batches for 8 crops; 53 jtl_05 harvest rows already linked '
      'here with normal ages (d54-82); both houses winter crops show a 46d '
      'seeding->first-pick lag.'),
    updated_at = now(), updated_by = 'cuke-lineage-fix'
where b.site_id='jtl_06' and b.seeding_date='2026-01-13' and b.is_deleted=false
  and not exists (select 1 from grow_cuke_seed_batch t
                  where t.site_id='jtl_05' and t.seeding_date='2026-01-13'
                    and t.is_deleted=false);

-- (ii) retire duplicates the sync re-created (they carry no harvest rows)
update grow_cuke_seed_batch b
set is_deleted = true,
    notes = concat_ws(' | ', notes,
      'Retired by cuke-lineage-fix: duplicate of the jtl_05 2026-01-13 cycle, '
      're-inserted by the upstream sync after that cycle was re-homed.'),
    updated_at = now(), updated_by = 'cuke-lineage-fix'
where b.site_id='jtl_06' and b.seeding_date='2026-01-13' and b.is_deleted=false
  and exists (select 1 from grow_cuke_seed_batch t
              where t.site_id='jtl_05' and t.seeding_date='2026-01-13'
                and t.is_deleted=false)
  and not exists (select 1 from grow_harvest_weight h
                  where h.grow_cuke_seed_batch_id = b.id and h.is_deleted=false);

-- JTL_06's own tail rows (Apr 15-19 2026) belong to its 2025-12-31 batch.
with tgt as (select id, invnt_item_id from grow_cuke_seed_batch
             where site_id='jtl_06' and seeding_date='2025-12-31' and is_deleted=false),
src as (select h.id, b.invnt_item_id from grow_harvest_weight h
        join grow_cuke_seed_batch b on b.id = h.grow_cuke_seed_batch_id
        where h.gh_site_id='jtl_06' and h.is_deleted=false
          and b.seeding_date='2026-01-13')
update grow_harvest_weight h
set grow_cuke_seed_batch_id = tgt.id, updated_at = now(), updated_by='cuke-lineage-fix'
from src join tgt on tgt.invnt_item_id = src.invnt_item_id
where h.id = src.id;

-- Crop 5 (2026-02-28..04-05): rows back-charged to the 2025-10-23 batch.
with tgt as (select id, invnt_item_id from grow_cuke_seed_batch
             where site_id='jtl_05' and seeding_date='2026-01-13' and is_deleted=false),
src as (select h.id, b.invnt_item_id from grow_harvest_weight h
        join grow_cuke_seed_batch b on b.id = h.grow_cuke_seed_batch_id
        where h.gh_site_id='jtl_05' and h.is_deleted=false
          and h.harvest_date between '2026-02-28' and '2026-04-05'
          and b.seeding_date='2025-10-23')
update grow_harvest_weight h
set grow_cuke_seed_batch_id = tgt.id, updated_at = now(), updated_by='cuke-lineage-fix'
from src join tgt on tgt.invnt_item_id = src.invnt_item_id
where h.id = src.id;

-- ---------------------------------------------------------------- A2 ------
-- Recreate the never-recorded ~2025-05-06 cycle (varieties J and K only).
-- Seeding date INFERRED: cadence 2025-02-11 + 84d = 05-06, and first pick
-- 06-13 implies a 38d lag (house range 33-42d). rows/seeds COPIED from this
-- house's 2025-02-11 batch as an estimate — NOT measured.
insert into grow_cuke_seed_batch
  (org_id, farm_id, site_id, invnt_item_id, seeding_date, transplant_date,
   rows_4_per_bag, rows_5_per_bag, seeds, status, cycle_code,
   created_by, updated_by, notes)
select b.org_id, b.farm_id, 'jtl_05', b.invnt_item_id,
       date '2025-05-06', date '2025-05-20',
       b.rows_4_per_bag, b.rows_5_per_bag, b.seeds, 'Harvested', '250505',
       'cuke-lineage-fix', 'cuke-lineage-fix',
       'Reconstructed 2026-08-08: cycle never recorded, so its harvest '
       '(2025-06-13..07-31) was split between the 2025-02-11 batch (as d122-154) '
       'and the 2025-07-31 batch (as negative ages). Seeding date INFERRED; '
       'rows/seeds COPIED from the 2025-02-11 batch - not measured.'
from grow_cuke_seed_batch b
where b.site_id='jtl_05' and b.seeding_date='2025-02-11' and b.is_deleted=false
  and b.invnt_item_id in ('Delta Star Minis(RZ)','F1 TSX-CU235JP(Tokita)')
  and not exists (select 1 from grow_cuke_seed_batch x
                  where x.site_id='jtl_05' and x.seeding_date='2025-05-06'
                    and x.invnt_item_id = b.invnt_item_id and x.is_deleted=false);

-- Crop 2 (2025-06-13..07-31): rows split across the 02-11 and 07-31 batches.
with tgt as (select id, invnt_item_id from grow_cuke_seed_batch
             where site_id='jtl_05' and seeding_date='2025-05-06' and is_deleted=false),
src as (select h.id, b.invnt_item_id from grow_harvest_weight h
        join grow_cuke_seed_batch b on b.id = h.grow_cuke_seed_batch_id
        where h.gh_site_id='jtl_05' and h.is_deleted=false
          and h.harvest_date between '2025-06-13' and '2025-07-31'
          and b.seeding_date in ('2025-02-11','2025-07-31'))
update grow_harvest_weight h
set grow_cuke_seed_batch_id = tgt.id, updated_at = now(), updated_by='cuke-lineage-fix'
from src join tgt on tgt.invnt_item_id = src.invnt_item_id
where h.id = src.id;

-- ----------------------------------------------------------------- B ------
-- BIP_HK Nov 8-9 2024 -> the 2024-10-02 batch (121d crop becomes 90d).
with tgt as (select id, invnt_item_id from grow_cuke_seed_batch
             where site_id='bip_hk' and seeding_date='2024-10-02' and is_deleted=false),
src as (select h.id, b.invnt_item_id from grow_harvest_weight h
        join grow_cuke_seed_batch b on b.id = h.grow_cuke_seed_batch_id
        where h.gh_site_id='bip_hk' and h.is_deleted=false
          and h.harvest_date between '2024-11-08' and '2024-11-09'
          and b.seeding_date='2024-07-11')
update grow_harvest_weight h
set grow_cuke_seed_batch_id = tgt.id, updated_at = now(), updated_by='cuke-lineage-fix'
from src join tgt on tgt.invnt_item_id = src.invnt_item_id
where h.id = src.id;

commit;

-- ============================================================================
-- VERIFICATION — every row below must read PASS
-- ============================================================================
with b as (select distinct upper(site_id) gh, seeding_date, transplant_date
           from grow_cuke_seed_batch where is_deleted=false and seeding_date >= '2021-06-01'),
seq as (select gh, seeding_date,
               lead(transplant_date) over (partition by gh order by seeding_date) next_transplant from b),
cyc as (select greenhouse, seeding_date, max(days_since_seed) crop_len, max(harvest_date) last_harvest
        from grow_cuke_harvest where days_since_seed >= 0 group by 1,2),
viol as (select count(*) n from cyc c join seq s
           on s.gh=c.greenhouse and s.seeding_date=c.seeding_date
         where s.next_transplant is not null and (c.last_harvest - s.next_transplant) > 2)
select 'crop overlaps next transplant by >2d' chk, (select n from viol)::text got, '0' want,
       case when (select n from viol)=0 then 'PASS' else 'FAIL' end result
union all select 'harvest linked to another house''s batch',
  (select count(*)::text from grow_cuke_harvest h join grow_cuke_seed_batch b2
     on b2.id=h.grow_cuke_seed_batch_id where upper(b2.site_id) <> h.greenhouse), '0',
  case when (select count(*) from grow_cuke_harvest h join grow_cuke_seed_batch b2
     on b2.id=h.grow_cuke_seed_batch_id where upper(b2.site_id) <> h.greenhouse)=0
     then 'PASS' else 'FAIL' end
union all select 'days_since_seed > 125',
  (select count(*)::text from grow_cuke_harvest where days_since_seed > 125), '0',
  case when (select count(*) from grow_cuke_harvest where days_since_seed > 125)=0
     then 'PASS' else 'FAIL' end
union all select 'days_since_seed < 0 (excl. BIP_HI 2022 legacy)',
  (select count(*)::text from grow_cuke_harvest
   where days_since_seed < 0 and harvest_date >= '2023-01-01'), '0',
  case when (select count(*) from grow_cuke_harvest
   where days_since_seed < 0 and harvest_date >= '2023-01-01')=0 then 'PASS' else 'FAIL' end
union all select 'JTL_05 distinct cycles since 2024-12',
  (select count(distinct seeding_date)::text from grow_cuke_harvest
   where greenhouse='JTL_05' and harvest_date >= '2024-12-01'), '8',
  case when (select count(distinct seeding_date) from grow_cuke_harvest
   where greenhouse='JTL_05' and harvest_date >= '2024-12-01')=8 then 'PASS' else 'FAIL' end
union all select 'BIP_HK 2024-07-11 crop length',
  (select coalesce(max(days_since_seed),-1)::text from grow_cuke_harvest
   where greenhouse='BIP_HK' and seeding_date='2024-07-11'), '90',
  case when (select max(days_since_seed) from grow_cuke_harvest
   where greenhouse='BIP_HK' and seeding_date='2024-07-11')=90 then 'PASS' else 'FAIL' end
union all select 'active jtl_06 batches on 2026-01-13 (dupes)',
  (select count(*)::text from grow_cuke_seed_batch
   where site_id='jtl_06' and seeding_date='2026-01-13' and is_deleted=false), '0',
  case when (select count(*) from grow_cuke_seed_batch
   where site_id='jtl_06' and seeding_date='2026-01-13' and is_deleted=false)=0
   then 'PASS' else 'FAIL' end;
