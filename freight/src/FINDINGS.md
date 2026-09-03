# What the model cannot answer on its own

Every finding and every number renders live on the **Cucumbers** and **Findings**
tabs of `index.html`, computed from the same engine as the rest of the model.
This file used to repeat them and drifted. What is left here is the part no code
can settle.

Current window: 13 sailings, 2026-07-17 → 08-28, annualised at ×8.00.
Air is defaulted at $0.33/lb.

## Seven questions for a human

1. **Can a PO be split between a box truck and a container?**
   Worth roughly **$29,500/yr** — by a distance the largest open question here.
   That is the pallet rate on the weight moved plus the port runs it saves: a
   truck carries eight pallets whether it is full or not, so taking five off it
   can drop a whole run. With a PO held whole only four pallets over the whole window ever
   qualify to move; without the rule, 33 to 41 do. The records already show POs
   split across the two containers, so the belief and the data disagree.

2. **How tall can a stacked space be?**
   66 cases is one full pallet and the conservative reading. The palletization
   records contain real pairs of **72 and 78**. Worth about $4,000/yr between the
   ends, and it is a toggle on the Cucumbers page.

3. **What does a JR or JW case actually weigh?**
   14, 16 or 18 lb. They are sold by the piece, so `case_net_weight` is an
   assumed average set at 14; the model overrides to 16. It decides the
   container-versus-loose call for the two heaviest codes. One pallet on a scale.

4. **Is the $200 loading charge right?**
   It sets what a container space costs, and so whether a 12 lb case can ever pay
   for one. **KR misses the line by 20 lb — 2% of a pallet.** At $0 loading it
   clears by 68. Also a toggle.

5. **Are there other loose-chill-only customers** beyond Costco Maui, Costco
   Kauai and Farm Link? 69 of 128 box pallets belong to those three and can never
   ride a container. Each one found shrinks every packing opportunity.

6. **How many local Costco Kona runs are there in a week, really?**
   The records hold three box-truck-only days where a standing Monday/Thursday
   round would be twelve.

7. **Why do local box truck runs appear in the palletization tables only
   sometimes?**

## Two things to fix in the data

- **Orphaned pallet allocations.** Editing a PO deletes its fulfillment rows and
  writes new ones, but the pallet allocations still point at the deleted rows —
  the pallet keeps its case count and loses its product, customer and PO. Fully
  recoverable. Written up for Michael in `ORPHANED-ALLOCATIONS.md`.
- **`sales_product` contradicts itself.** `maximum_case_per_pallet` holds the
  short-pallet figure for codes that do not ship and the full figure for those
  that do; there is no column at all for the short-pallet count; and five
  products have a `pallet_net_weight` that disagrees with cases × case weight.

## One that is fixed, but worth knowing about

`annualize` was hardcoded at 8.67 — 104 sailings a year over the 12 in the
original window. The extract is not pinned to a date range, so when a 13th
sailing appeared every figure silently inflated by 8%. It is now derived as
104 ÷ ship_days. **If the extract ever moves to a different sailing frequency,
that 104 is the number to revisit.**
