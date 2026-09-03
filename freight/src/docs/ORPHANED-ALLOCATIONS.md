# Editing a PO detaches pallets from their product

**Found:** 2026-08-25, while building the freight cost model.
**Severity:** low impact today, latent risk in EDI. Not urgent, but it recurs on
every PO edit made after pallets are built.
**Status:** nothing changed. Raising it before touching the palletization code.

## What happens

`app/lib/sales-po/po-update.server.ts:205` reconciles fulfillments by
wipe-and-rewrite. Its own comment says so:

```
// Fulfillment reconciliation: simple wipe+rewrite per line.
// For each line in the payload, soft-delete its current fulfillment rows
// and insert the new set from the form.
```

```js
// 1. soft-delete every live fulfillment on the line
await client.from('sales_po_fulfillment')
  .update({ is_deleted: true, updated_by: auditUser })
  .in('sales_po_line_id', linesToWipe).eq('is_deleted', false);

// 2. insert the replacements -- with new ids
await client.from('sales_po_fulfillment').insert(fulfillmentRows);

// 3. nothing touches sales_pallet_allocation
```

`sales_pallet_allocation.sales_po_fulfillment_id` still points at the row killed
in step 1. The replacements get fresh UUIDs, so any pallet already built against
that PO line is silently detached from its product.

Nothing at the database level catches it: no trigger on
`sales_po_fulfillment`, and the FK is `NO ACTION` (irrelevant anyway for a soft
delete).

## Why it shows up in the view

`sales_palletization_v` puts each delete filter in the ON clause of a LEFT JOIN:

```sql
LEFT JOIN sales_pallet_allocation a ON a.sales_pallet_id = p.id            AND a.is_deleted = false
LEFT JOIN sales_po_fulfillment   ff ON ff.id = a.sales_po_fulfillment_id   AND ff.is_deleted = false
LEFT JOIN sales_po_line         pol ON pol.id = ff.sales_po_line_id        AND pol.is_deleted = false
LEFT JOIN sales_product        prod ON prod.id = pol.sales_product_id      AND prod.is_deleted = false
...
COALESCE(a.allocated_quantity, p.manual_cases) AS allocated_quantity
```

`ff` resolves to NULL, which cascades to `pol` and `prod`, but
`a.allocated_quantity` survives. **The pallet keeps its case count and loses its
product, product name, customer, PO number and UPC.**

## The state it leaves behind

Neither half is complete, and nothing joins them:

- the **live fulfillment** knows the cases and the PO, but not the pallet
- the **orphaned allocation** knows the pallet, but points at a deleted fulfillment

## Scope

Across all 773 allocations:

| allocation | fulfillment | count | meaning |
|---|---|---:|---|
| live | live | 759 | normal |
| live | **deleted** | **14** | orphaned |
| deleted | deleted | 0 | the cleanup has never run |
| deleted | live | 0 | |
| dangling FK | | 0 | |

Zero correctly-cascaded rows: there is no cleanup path, so this is not an
occasional race. Four separate PO edits, same user, spread over three weeks:

| deleted on | prod | pallet | cases | ship day | live replacement | live allocs |
|---|---|---|---:|---|---:|---:|
| 2026-07-30 | JR | Foodland_01 | 48 | 07-31 | 1 fulfil, 36 cases | 0 |
| 2026-07-30 | KR | CP20 | 38 | 07-31 | 2 fulfils, 68 cases | 0 |
| 2026-07-30 | KR | CP20 | 28 | 07-31 | 2 fulfils, 68 cases | 0 |
| 2026-07-30 | KR | Foodland_01 | 2 | 07-31 | 2 fulfils, 68 cases | 0 |
| 2026-07-30 | LR | Foodland_02 | 9 | 07-31 | 1 fulfil, 9 cases | 0 |
| 2026-07-30 | WR | Foodland_02 | 5 | 07-31 | 1 fulfil, 5 cases | 0 |
| 2026-08-06 | JW | CP12 | 60 | 08-07 | 1 fulfil, 78 cases | 0 |
| 2026-08-06 | JW | CP13 | 18 | 08-07 | 1 fulfil, 78 cases | 0 |
| 2026-08-06 | KW | CP14 | 54 | 08-07 | 2 fulfils, 144 cases | 0 |
| 2026-08-06 | KW | CP15 | 18 | 08-07 | 2 fulfils, 144 cases | 0 |
| 2026-08-06 | KW | CP15 | 48 | 08-07 | 2 fulfils, 144 cases | 0 |
| 2026-08-06 | KW | CP16 | 24 | 08-07 | 2 fulfils, 144 cases | 0 |
| 2026-08-17 | KW | CP18 | 54 | 08-18 | 1 fulfil, 54 cases | 0 |
| 2026-08-18 | KF | Manson Products_01 | 48 | 08-18 | 1 fulfil, 48 cases | 0 |

**10 pallets, 454 cases.** Every affected line has a live replacement
fulfillment; every one of them has **zero** allocations.

Affected POs:

| PO | customer | group |
|---|---|---|
| 006870803275 | 687 Iwilei | Costco |
| 2185407813 | Sam's Club 4755 | Sam's |
| 324923 | Foodland | Foodland |
| 64353 | Manson Products | Small |

## What it does and does not break

**Not double-counted.** The pallets are real and shipped, in real container
slots. The orphaned allocation is the only record of what is on them, so cases
are counted once, not twice.

**Fully recoverable.** `sales_po_line` is still live and names the product,
which is how all 454 cases were reconstructed.

**Invoicing looks unaffected.** The live fulfillments carry the right
quantities, matching `order_quantity` on 7 of 8 lines. The exception is JR:
48 orphaned cases against a 36-case live fulfillment. Worth a separate look.

**EDI was not affected in practice, but the path is live.**
`asn-groups.server.ts:91` builds the ASN from live fulfillments and looks up the
pallet through `sales_pallet_allocation`. With zero live allocations,
`pallet_number` resolves to NULL -- the field a retail DC scans on receipt. No
ASN was generated for any of these four POs, so nothing went out wrong. Two of
them are EDI customers (Costco, Sam's) and there are 52 cartons across 19 ASNs
elsewhere in the system, so a future edit on an ASN'd PO would land badly.

**What is visibly broken today:** those pallets read blank in the palletization
grid, and print blank on the pallet sheet (`routes/print/palletization.tsx`).

## Options

1. **Real fix.** Stop wipe-and-rewrite. Reconcile fulfillments by identity so
   ids survive an edit and allocations stay attached. Bigger change, and your
   call on the design.
2. **Cheap guard now.** Refuse the wipe when live allocations reference those
   fulfillments, and tell the user to unpalletize first. Stops the recurrence
   without redesigning anything.
3. **Data repair.** Migration re-pointing the 14 orphans at the live fulfillment
   for the same PO line.

Happy to write 2 and 3 and leave 1 to you.

## Other odd data found along the way

Not the same bug, but everything else that looked wrong while building the
model. Listed so it is in one place.

### 2026-07-20: a sailing that cannot have happened

Both containers are booked with a total of nine pallets:

| container | vehicle | spaces used | pallets | cases |
|---|---|---|---:|---:|
| cucumber | HFA Cuke Container | 1,2,3,4,5,6 | 6 | 336 |
| lettuce | HFA Lettuce Container | 1,2,3 | 3 | 60 |

A container is 18 floor spaces and costs the same whether it is full. Nobody
sends two of them for nine pallets, and it is the only Monday sailing in the
window -- every other one is a Tuesday or Friday. Pricing it charges $4,500
against nine pallets, so the freight model drops it as a data error. Worth
knowing how it got written, since the `vehicle` values are the real containers
rather than a box truck.

For contrast, the three genuine box-truck-only days (07-27, 07-30, 08-17) each
carry a handful of lettuce pallets with no container at all -- local deliveries,
correctly recorded, and excluded from the freight window as not-freight.

### Japanese cucumber case weights are too low

`sales_product` carries JR and JW at 14 lb per case. They are sold by the piece,
so the case weight is an assumed average, and it was set too low -- 16 lb is
closer. The freight model overrides it in its own extract rather than writing
back to the product master.

Suggestive detail: JR's stored `pallet_net_weight` is 1,188, which is
66 x 18 -- so at some point someone had this case at **18** lb, not 14 or 16.
Worth putting a few pallets on a scale, because the container-versus-pallet
decision turns on a margin of a few percent.

### `pallet_net_weight` contradicts its own fields on five products

The column is hand-entered and never recalculated, so it drifts from
`case_net_weight` x `maximum_case_per_pallet`:

| code | product | case lb | max cases/pallet | stored | should be | implied cases |
|---|---|---:|---:|---:|---:|---:|
| AF | Keiki Arugula Food Service | 10.00 | 15 | 360 | 150 | 36 |
| AR | Keiki Arugula 9ct 4oz tray | 2.25 | 28 | 126 | 63 | 56 |
| EF | English Cukes 15# Food Service | 15.00 | 30 | 900 | 450 | 60 |
| JR | Japanese Cukes 18ct 3-pack | 14.00 | 66 | 1,188 | 924 | 85 |
| KF | Keiki Cukes 12# Food Service | 12.00 | 66 | 720 | 792 | 60 |

AF, AR and EF are all exactly 2x their computed value, and their implied
cases-per-pallet (36, 56, 60) are the familiar counts from other products --
which reads like `maximum_case_per_pallet` was halved for those three, perhaps a
genuine move to single-stacking, without touching the weight. JR and KF look
like plain stale values.

Nothing reads this column: no view, no function, and in the app only
`sales-product.config.ts` for the edit form. So it is wrong on a form rather
than corrupting anything. It does mislead when someone opens a product record to
sanity-check a case weight, which is how the JR discrepancy surfaced.

Deriving cases-per-pallet from it is unsafe --
`pallet_net_weight / case_net_weight` returns 85 for JR where
`maximum_case_per_pallet` correctly says 66.

## Reproducing

```sql
-- the 14 orphans
select a.id, a.allocated_quantity, p.pallet_number, p.target_invoice_date,
       l.sales_product_id
from sales_pallet_allocation a
join sales_po_fulfillment f on f.id = a.sales_po_fulfillment_id
join sales_pallet p on p.id = a.sales_pallet_id
left join sales_po_line l on l.id = f.sales_po_line_id
where a.is_deleted = false and f.is_deleted = true;

-- how they surface
select target_invoice_date, container, pallet_number, prod_code, allocated_quantity
from sales_palletization_v where prod_code is null;

-- the 07-20 sailing
select container, vehicle, container_space_number, pallet_id, allocated_quantity
from sales_palletization_v where target_invoice_date = '2026-07-20';

-- products whose stored pallet weight contradicts their own fields
select id, name, case_net_weight, maximum_case_per_pallet, pallet_net_weight,
       maximum_case_per_pallet * case_net_weight as should_be
from sales_product
where is_deleted = false
  and pallet_net_weight is distinct from maximum_case_per_pallet * case_net_weight
  and pallet_net_weight is not null and maximum_case_per_pallet is not null;
```
