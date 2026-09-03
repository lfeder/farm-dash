"""Pull the palletization history from prod and write data.json.

This touches the network and needs SUPABASE_ACCESS_TOKEN. It does NOT build the
viewer -- run build.py for that. They are separate because the query is not
pinned to a date range, so every pull can widen the window and move every figure
on the page; rebuilding after a template edit should not be able to do that.

sales_product understates the Japanese cucumber cases: JR and JW are carried at
14 lb but weigh 16. The override lives here rather than in the database because
this model should not quietly rewrite the ERP's own product master.

One row per ship day x crop x container: pallets, floor spaces, cases and the
summed case weight. Everything the scenarios need is derived in the browser so
the rates stay editable without a re-extract.

Usage: SUPABASE_ACCESS_TOKEN=... python3 extract.py
"""
import json
import re, os, sys, urllib.request

REF = "zdvpqygiqavwpxljpvqw"

# Cases a pallet holds at short and full height. Supabase has no column for the
# short figure -- maximum_case_per_pallet holds the full one for every code that
# ships -- so it is carried here, from the product sheet. A pallet can only take
# another on top if it is at or under the short count; LW cannot stack at all.
PALLET_CASES = {
    "AF": (15, 30), "AR": (28, 56), "EF": (30, 66),
    "JR": (30, 66), "JW": (30, 66), "KF": (30, 66),
    "KR": (30, 66), "KW": (30, 66),
    "LF": (15, 36), "LR": (28, 56), "LW": (0, 20),
    "WF": (15, 30), "WR": (28, 56),
}

# prod_code -> corrected net case weight, overriding sales_product.
CASE_WEIGHT_OVERRIDE = {"JR": 16.0, "JW": 16.0}

_OVERRIDE_SQL = " ".join(
    f"when '{code}' then {w}::numeric" for code, w in CASE_WEIGHT_OVERRIDE.items()
)

SQL = """
-- The barge sails Tuesday and Friday. Other days carry only box-truck runs --
-- local lettuce deliveries, not freight -- so they are dropped outright
-- rather than priced as if a container could have been dispatched.
with sailing_days as (
  select target_invoice_date as dt
  from public.sales_palletization_v
  where container in ('lettuce', 'cucumber')
  group by 1
  -- 2026-07-20 books 3 lettuce and 6 cucumber pallets against both containers.
  -- No container sails that empty; it is a mislabelled local run, and pricing
  -- it would charge $4,500 of container against nine pallets.
  having count(distinct container_space_number) >= 10
)
select
  pv.target_invoice_date::text as dt,
  pv.farm_id                   as crop,
  pv.container,
  count(distinct pv.pallet_id)::int                            as pallets,
  count(distinct pv.container_space_number)::int               as spaces,
  sum(pv.allocated_quantity::numeric)::int                     as cases,
  round(sum(pv.allocated_quantity::numeric
            * coalesce(case pv.prod_code __OVERRIDE__ else sp.case_net_weight end,
                       0)))::int                               as product_lbs,
  -- case_net_weight is product only, so the carton is counted separately. The
  -- 2.25 lb retail cases (LR, WR) use a lighter box than everything else.
  sum(pv.allocated_quantity::numeric)
    filter (where pv.prod_code not in ('LR', 'WR')
               or pv.prod_code is null)::int                   as cases_std,
  coalesce(sum(pv.allocated_quantity::numeric)
    filter (where pv.prod_code in ('LR', 'WR')), 0)::int       as cases_retail,
  count(*) filter (where sp.case_net_weight is null)::int      as missing_wt_rows
from public.sales_palletization_v pv
left join public.sales_product sp on sp.id = pv.prod_code
where pv.target_invoice_date in (select dt from sailing_days)
group by 1, 2, 3
order by 1, 2, 3;
"""


def query(sql):
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{REF}/database/query",
        data=json.dumps({"query": sql}).encode(),
        headers={"Authorization": "Bearer " + os.environ["SUPABASE_ACCESS_TOKEN"],
                 "Content-Type": "application/json",
                 # the WAF 403s the default python-urllib agent
                 "User-Agent": "Mozilla/5.0 freight-model"})
    try:
        return json.load(urllib.request.urlopen(req))
    except urllib.error.HTTPError as e:
        sys.exit(f"{e.code} {e.read().decode()[:2000]}")


# Fill rates have to be counted per container, not summed from the per-crop
# rows: a space holding two crops would otherwise be counted twice.
FILL_SQL = """
with sailing_days as (
  select target_invoice_date as dt
  from public.sales_palletization_v
  where container in ('lettuce', 'cucumber')
  group by 1
  having count(distinct container_space_number) >= 10
)
-- A floor space can hold two short ("Stackable") pallets. Counting what is
-- actually in each space shows how often that second slot goes unused.
, space as (
  select target_invoice_date as dt, container, container_space_number as sn,
         count(distinct pallet_id)::int as n,
         max(pallet_type)               as ptype
  from public.sales_palletization_v
  where target_invoice_date in (select dt from sailing_days)
    and container in ('lettuce', 'cucumber')
  group by 1, 2, 3
)
select
  dt::text,
  container,
  count(*)::int                                              as spaces,
  sum(n)::int                                                as pallets,
  count(*) filter (where ptype = 'Stackable' and n = 1)::int as lone_short,
  count(*) filter (where ptype = 'Stackable' and n = 2)::int as paired,
  count(*) filter (where ptype = 'Full')::int                as full_pallets
from space
group by 1, 2
order by 1, 2;
"""

# Product master for the weights page. Everything derived from these numbers
# (carton, billable, full-pallet) is computed in the browser so the box weights
# stay editable there too.
PRODUCT_SQL = """
select
  sp.id,
  sp.name,
  sp.case_net_weight::float                                  as db_net,
  sp.pallet_net_weight::float                                as db_pallet_net,
  sp.maximum_case_per_pallet::int                            as cases_per_pallet,
  -- pallet_net_weight is stored, not derived, and several codes disagree with
  -- their own case weight: JR holds 1188 (66 x 18) while JW holds 924
  -- (66 x 14). The mismatch is judged against the effective case weight in the
  -- browser, so an overridden code is measured against the corrected figure.
  coalesce(x.farm, '')                                       as farm,
  coalesce(x.cases, 0)::int                                  as cases_shipped,
  coalesce(x.pallets, 0)::int                                as pallets_shipped
from public.sales_product sp
left join (
  select prod_code, max(farm_id) as farm,
         sum(allocated_quantity)::int as cases,
         count(distinct pallet_id)::int as pallets
  from public.sales_palletization_v group by 1
) x on x.prod_code = sp.id
where sp.case_net_weight is not null
order by (x.cases is null), coalesce(x.farm, 'zz'), sp.id;
"""

# Pallet-level detail behind the weight-utilisation column, so a space that is
# not carrying its weight can be traced to the pallets in it.
DETAIL_SQL = """
with sailing_days as (
  select target_invoice_date as dt
  from public.sales_palletization_v
  where container in ('lettuce', 'cucumber')
  group by 1
  having count(distinct container_space_number) >= 10
),
-- Per product first, so a pallet carrying more than one keeps the split. Rolled
-- straight to the pallet it is lost, and there is then no way to say how full a
-- mixed pallet is: each product fills a different share of one.
alloc as (
  select
    pv.target_invoice_date::text      as dt,
    pv.container,
    pv.container_space_number::int    as space,
    pv.pallet_number,
    pv.pallet_type,
    pv.farm_id                        as crop,
    pv.customer_name                  as customer,
    pv.customer_group_name            as grp,
    pv.po_number                      as po,
    pv.prod_code,
    sum(pv.allocated_quantity)::int   as cases,
    round(sum(pv.allocated_quantity
          * (case pv.prod_code __OVERRIDE__ else sp.case_net_weight end))) as lbs
  from public.sales_palletization_v pv
  left join public.sales_product sp on sp.id = pv.prod_code
  where pv.target_invoice_date in (select dt from sailing_days)
  group by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
)
select
  dt, container, space, pallet_number, pallet_type, crop, customer, grp, po,
  string_agg(distinct prod_code, '/' order by prod_code) as prods,
  sum(cases)::int                                        as cases,
  sum(lbs)::int                                          as product_lbs,
  jsonb_object_agg(coalesce(prod_code, '?'), cases)      as mix
from alloc
group by 1, 2, 3, 4, 5, 6, 7, 8, 9
order by 1, 2, 3, 4;
"""

# Pounds cut, per day, per crop. This is the one figure the palletization
# history cannot supply at any level of effort: it records what left the island,
# stamped with the sailing date, so it knows neither what was grown nor which
# day it was cut on. The two crops keep their weights in different tables
# because they are weighed differently -- lettuce by pond and side off the
# harvest boards, cucumbers by tote out of each greenhouse -- and net_weight is
# after tare in both.
#
# Lettuce cuts four days a week and cucumbers cut seven, so the day-of-week
# pattern is a fact about the crop, not about the schedule, and is left for the
# browser to read rather than being folded up here.
HARVEST_SQL = """
select 'lettuce' as crop, harvest_date::text as dt,
       round(sum(net_weight))::int   as net_lb,
       round(sum(gross_weight))::int as gross_lb,
       count(*)::int                 as entries
from public.grow_lettuce_pond_weight
where coalesce(is_deleted, false) = false and harvest_date >= '__FROM__'
group by 1, 2
union all
select 'cuke', harvest_date::text,
       round(sum(net_weight))::int, round(sum(gross_weight))::int, count(*)::int
from public.grow_harvest_weight
where coalesce(is_deleted, false) = false and farm_id = 'Cuke'
  and harvest_date >= '__FROM__'
group by 1, 2
order by 1, 2;
"""
# The lettuce pond weights start here; there is no point pulling cucumbers back
# to 2020 for a page that only ever shows them beside lettuce.
HARVEST_FROM = "2026-06-28"

# On-island, which the sailing-day filter above throws away on purpose: Kona is
# served off our own box trucks on days no container moves, so those days never
# clear the ten-space test and the whole customer disappears from the freight
# history. It is a real destination with real pounds against it, and the model
# was calling its absence a gap.
ON_ISLAND_CUSTOMER = "140 Kona"

# Where the product actually went, from the purchase orders rather than from the
# palletization. Two reasons it has to come from here.
#
# The palletization view only holds what somebody built a pallet for, and it
# misses more than half of Kona: fourteen invoiced Local Delivery orders in
# 2026-07-13..08-28, six of them palletized. Reading on-island off the pallets
# undercounts it by 3,780 lb of lettuce in seven weeks.
#
# And it has no notion of pick-up at all. sales_fob is the farm's own vocabulary
# for how an order leaves -- Farm, Local Delivery, HNL, Kawaihae, Off-island
# (AP), Off-island (HFA) -- and a whole tier of Big Island accounts collect at
# the gate under FOB Farm. None of them ever reach a container, so none of them
# appear in the freight history, which is most of what "packed but not shipped"
# was.
#
# Aggregated to the week and half the page reads in: Sunday-start weeks, and
# Sun/Mon/Tue against Wed/Thu/Fri/Sat, so a Monday delivery answers to the first
# cut and a Thursday one to the second.
SALES_SQL = """
select
  case when l.farm_id = 'Lettuce' then 'lettuce' else 'cuke' end             as crop,
  (po.invoice_date - (extract(dow from po.invoice_date))::int)::text         as wk,
  case when extract(dow from po.invoice_date) <= 2 then 'early' else 'late'
  end                                                                       as half,
  case when po.sales_customer_id = '__KONA__'                    then 'kona'
       when po.sales_fob_id = 'Farm'                             then 'pickup'
       when po.sales_fob_id in ('Off-island (HFA)', 'Off-island (AP)',
                                'HNL', 'Kawaihae')               then 'off'
       else 'other' end                                                     as bucket,
  round(sum(coalesce(l.invoice_quantity, l.order_quantity)
        * coalesce(case l.sales_product_id __OVERRIDE__ else sp.case_net_weight end,
                   0)))::int                                                as lbs,
  -- Orders arrive in cases and the harvest is weighed, so both units have to
  -- travel together or somebody does the conversion in their head.
  sum(coalesce(l.invoice_quantity, l.order_quantity))::int                  as cases
from public.sales_po po
join public.sales_po_line l
  on l.sales_po_id = po.id and coalesce(l.is_deleted, false) = false
left join public.sales_product sp on sp.id = l.sales_product_id
where coalesce(po.is_deleted, false) = false
  and po.invoice_date >= '__FROM__'
group by 1, 2, 3, 4
having round(sum(coalesce(l.invoice_quantity, l.order_quantity)
       * coalesce(case l.sales_product_id __OVERRIDE__ else sp.case_net_weight end,
                  0))) <> 0
order by 1, 2, 3, 4;
"""
ONISLAND_SQL = """
select
  case when pv.farm_id = 'Lettuce' then 'lettuce' else 'cuke' end as crop,
  pv.target_invoice_date::text                                    as dt,
  sum(pv.allocated_quantity)::int                                 as cases,
  round(sum(pv.allocated_quantity::numeric
        * coalesce(case pv.prod_code __OVERRIDE__ else sp.case_net_weight end,
                   0)))::int                                      as lbs
from public.sales_palletization_v pv
left join public.sales_product sp on sp.id = pv.prod_code
where pv.customer_name = '__CUST__' and pv.target_invoice_date >= '__FROM__'
group by 1, 2
order by 1, 2;
"""

rows = query(SQL.replace("__OVERRIDE__", _OVERRIDE_SQL))
if not rows:
    sys.exit("no palletization rows returned")
fill = query(FILL_SQL)

# Some freight can never ride a container: Costco Maui and Kauai are not on the
# barge the containers ride, and Farm Link's orders go loose chill. Splitting
# them out keeps them from being counted as a recoverable opportunity.
LOOSE_ONLY = ("119 Maui", "640 Kauai", "Farm Link Hawaii")

_LOOSE_SQL = ", ".join("'%s'" % c for c in LOOSE_ONLY)
BOX_SQL = """
with sailing_days as (
  select target_invoice_date as dt
  from public.sales_palletization_v
  where container in ('lettuce', 'cucumber')
  group by 1
  having count(distinct container_space_number) >= 10
)
select
  target_invoice_date::text as dt,
  count(distinct pallet_id)::int                                        as pallets,
  count(distinct pallet_id) filter (
    where customer_name in (__LOOSE__))::int                            as loose_only,
  count(distinct pallet_id) filter (
    where customer_name not in (__LOOSE__)
       or customer_name is null)::int                                   as spillover
from public.sales_palletization_v
where target_invoice_date in (select dt from sailing_days)
  and container = 'box'
group by 1
order by 1;
"""
box = query(BOX_SQL.replace("__LOOSE__", _LOOSE_SQL))
products = query(PRODUCT_SQL)
harvest = query(HARVEST_SQL.replace("__FROM__", HARVEST_FROM))
# Cases by what gets packed and where it goes, which is the shape the pack line
# is planned in: three case types at three different rates, on-island against
# off-island. AF is a 10 lb food-service case like LF and rides with it.
PACKS_SQL = """
select
  (po.invoice_date - (extract(dow from po.invoice_date))::int)::text        as wk,
  case when extract(dow from po.invoice_date) <= 2 then 'early' else 'late'
  end                                                                      as half,
  case when po.sales_fob_id in ('Off-island (HFA)', 'Off-island (AP)',
                                'HNL', 'Kawaihae') then 'off' else 'on' end as dest,
  case when l.sales_product_id = 'LW'            then 'LW'
       when l.sales_product_id in ('LF', 'AF')   then 'LF'
       else 'TRAY' end                                                     as grp,
  sum(coalesce(l.invoice_quantity, l.order_quantity))::int                 as cases
from public.sales_po po
join public.sales_po_line l
  on l.sales_po_id = po.id and coalesce(l.is_deleted, false) = false
where coalesce(po.is_deleted, false) = false
  and l.farm_id = 'Lettuce'
  and po.invoice_date >= '__FROM__'
group by 1, 2, 3, 4
having sum(coalesce(l.invoice_quantity, l.order_quantity)) <> 0
order by 1, 2, 3, 4;
"""

sales = query(SALES_SQL.replace("__OVERRIDE__", _OVERRIDE_SQL)
                       .replace("__KONA__", ON_ISLAND_CUSTOMER)
                       .replace("__FROM__", HARVEST_FROM))
packrows = query(PACKS_SQL.replace("__FROM__", HARVEST_FROM))
packs = {}
for r in packrows:
    k = (r["wk"], r["half"])
    packs.setdefault(k, {"wk": r["wk"], "half": r["half"], "on": {}, "off": {}})
    packs[k][r["dest"]][r["grp"]] = r["cases"]
packs = [packs[k] for k in sorted(packs)]
onisland = query(ONISLAND_SQL.replace("__OVERRIDE__", _OVERRIDE_SQL)
                             .replace("__CUST__", ON_ISLAND_CUSTOMER)
                             .replace("__FROM__", HARVEST_FROM))
detail = query(DETAIL_SQL.replace("__OVERRIDE__", _OVERRIDE_SQL))
# The 0.5 lb carton is the retail tray; everything else uses the standard box.
RETAIL_CODES = {"LR", "WR"}
for pr in products:
    pr["net"] = CASE_WEIGHT_OVERRIDE.get(pr["id"], pr["db_net"])
    pr["overridden"] = pr["id"] in CASE_WEIGHT_OVERRIDE
    pr["retail"] = pr["id"] in RETAIL_CODES

missing = sum(r["missing_wt_rows"] for r in rows)
days = sorted({r["dt"] for r in rows})

out = {
    "generated_from": "sales_palletization_v x sales_product, "
                       "grow_lettuce_pond_weight, grow_harvest_weight",
    "first_day": days[0],
    "last_day": days[-1],
    "ship_days": len(days),
    # Surfaced in the page so a weight gap can never masquerade as a cheap day.
    "rows_missing_case_weight": missing,
    "case_weight_override": CASE_WEIGHT_OVERRIDE,
    "loose_only": list(LOOSE_ONLY),
    "pallet_cases": {k: {"short": v[0], "full": v[1]} for k, v in PALLET_CASES.items()},
    "harvest_from": HARVEST_FROM,
    "harvest": harvest,
    "on_island_customer": ON_ISLAND_CUSTOMER,
    "onisland": onisland,
    "sales": sales,
    "packs": packs,
    "pack_groups": [["LW", "LW"], ["LF", "LF"], ["TRAY", "LR/AR/WR"]],
    "products": products,
    "detail": detail,
    "rows": rows,
    "fill": fill,
    "box": box,
}
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data.json")
with open(path, "w") as fh:
    json.dump(out, fh, indent=1)

print(f"{len(rows)} rows | {len(days)} ship days | {days[0]} -> {days[-1]}")
print(f"rows with no case weight: {missing}")
hdays = sorted({h["dt"] for h in harvest})
print(f"harvest: {len(harvest)} crop-days | {hdays[0]} -> {hdays[-1]}" if harvest
      else "harvest: NOTHING RETURNED")
print(f"packs: {len(packs)} windows x 3 case types x 2 destinations")
print(f"sales: {len(sales)} crop-week-half-buckets, "
      f"{sum(r['lbs'] for r in sales):,} lb" if sales else "sales: NOTHING RETURNED")
print(f"on-island ({ON_ISLAND_CUSTOMER}): {len(onisland)} crop-days, "
      f"{sum(r['lbs'] for r in onisland):,} lb" if onisland
      else f"on-island ({ON_ISLAND_CUSTOMER}): NOTHING RETURNED")
print(f"wrote {path}")

print("run build.py to rebuild index.html from this")
