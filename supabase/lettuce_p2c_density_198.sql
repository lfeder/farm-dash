-- P2C seeding density 330 -> 198 for every unharvested cycle (2026-09-06).
--
-- Lenny asked to bring P2C in line with P3C. The two lanes run the same plan
-- date-for-date (same seed/pond/harvest dates, same board counts) and differed
-- only in seeds-per-board: P2C 330, P3C 198.
--
-- Scope is "on the pond and future" = harvest_date IS NULL, which covers the 23
-- cycles already on the pond, the one germinating (seeded 09/05) and the 30
-- planned through the 10/27 seeding. 54 rows, 372 boards. Harvested history is
-- left alone — those densities are what was actually sown.
--
-- Density was uniform at 330 across all 54, so the flat overwrite loses no
-- per-cycle variation. There is no saved lettuce_builder_lane_config row for
-- P2C, so the builder's default for the lane follows the last cycle and now
-- picks up 198 on its own.

-- Pre-image, for rollback.
create table archive.lettuce_p2c_density_rollback_0906 as
select id, lane, seeding_date, transplant_date, estimated_harvest_date,
       number_of_units, seeds_per_unit
from grow_lettuce_seed_batch
where org_id = 'hawaii_farming' and coalesce(is_deleted, false) = false
  and lane = 'P2C' and harvest_date is null;

comment on table archive.lettuce_p2c_density_rollback_0906 is
  'Pre-image of seeds_per_unit for all unharvested P2C cycles before the '
  '2026-09-06 density change 330 -> 198 (Lenny). Rollback: update '
  'grow_lettuce_seed_batch b set seeds_per_unit = a.seeds_per_unit from '
  'archive.lettuce_p2c_density_rollback_0906 a where b.id = a.id. '
  'Safe to drop after 2026-12-31.';

-- The change. 54 rows.
update grow_lettuce_seed_batch
   set seeds_per_unit = 198
 where org_id = 'hawaii_farming' and coalesce(is_deleted, false) = false
   and lane = 'P2C' and harvest_date is null;
