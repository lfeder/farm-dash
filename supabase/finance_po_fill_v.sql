-- finance_po_fill_v — ordered vs fulfilled cases by iso-week / month / farm /
-- product, 2025+. Feeds the Sales dashboard Budget tab's "% short" charts.
-- Grain and shape mirror finance_sales_actuals_v so the client reuses the same
-- series code. Applied to prod as migration add_finance_po_fill_v.
--
-- Exclusions follow the documented sales rules:
--   * Trash / Donation customer groups are dispositions, not sales
--   * KFree / JFree are comp/giveaway products carried on every PO grid
--   * order_quantity = 0 lines are always_on_po shells, not real orders
-- Bucketed on sales_po.order_date: ordered and fulfilled then always land in
-- the same period, so the ratio never straddles a week boundary.
--
-- ordered_recorded is the ordered-case subtotal for lines that already carry a
-- fulfillment row. Fulfillment is keyed in days after the order, so a bucket
-- near "now" holds lines nobody has filled in yet; those must not be read as
-- 100%-short. A line that truly shipped nothing gets a row with
-- fulfilled_quantity = 0, so an absent row means unrecorded, not unfilled, and
-- ordered_recorded is the honest denominator for the fill ratio. Consumers
-- divide `fulfilled` by `ordered_recorded` and suppress a bucket whose
-- ordered_recorded / ordered coverage is too thin to trust.
-- Dropped rather than replaced: ordered_recorded sits mid-list, and
-- create-or-replace can only append columns to an existing view.
drop view if exists finance_po_fill_v;
create view finance_po_fill_v as
with f as (
  select sales_po_line_id, sum(fulfilled_quantity) as fulfilled
  from sales_po_fulfillment
  where not is_deleted
  group by 1
), a as (
  select extract(isoyear from p.order_date)::int as isoyear,
         extract(week    from p.order_date)::int as isoweek,
         extract(year    from p.order_date)::int as year,
         extract(month   from p.order_date)::int as month,
         li.farm_id,
         li.sales_product_id                      as product_code,
         sum(li.order_quantity)                   as ordered,
         sum(li.order_quantity) filter (where f.sales_po_line_id is not null)
                                                  as ordered_recorded,
         sum(coalesce(f.fulfilled, 0))            as fulfilled
  from sales_po_line li
  join sales_po p on p.id = li.sales_po_id
  left join f on f.sales_po_line_id = li.id
  where not li.is_deleted
    and not p.is_deleted
    and p.org_id = 'hawaii_farming'
    and coalesce(p.sales_customer_group_id, '') not in ('Trash', 'Donation')
    and li.sales_product_id not in ('KFree', 'JFree')
    and li.order_quantity > 0
    and p.order_date >= date '2025-01-01'
  group by 1, 2, 3, 4, 5, 6
)
select isoyear, isoweek, year, month, farm_id, product_code,
       ordered, coalesce(ordered_recorded, 0) as ordered_recorded, fulfilled,
       row_number() over (order by isoyear, isoweek, year, month, farm_id, product_code) as id
from a;

grant select on finance_po_fill_v to anon, authenticated, service_role;
