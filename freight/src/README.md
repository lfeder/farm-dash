# Freight cost model

Prices Hawaii Farming's outbound freight against what actually shipped: YB
containers, YB loose chill, and Aloha Air. Static HTML, no server.

```
open index.html          # that's it — nothing to build to read it
```

One file, five tabs. Deep links are `#cukes` and so on; the two
per-sailing tabs take a date after a slash — `#costco/2026-07-24`.

| tab | |
|---|---|
| **Lettuce** | Fly it or barge it. Pallet count and air rate are editable. |
| **Cucumbers** | The ledger: three scenarios, sailing by sailing. Click a row for the pallets and a 3D of the container. |
| **Shorts** | How many pallets go out under-filled, by customer. |
| **Trucks** | What each scenario asks of the box-truck fleet. |
| **Weights** | Case, carton and pallet weight per product code. |

## The question

Ship lettuce by barge container, or fly it and give the container to cucumbers?

## The answer

```
A  current                      $524,903
B  air lettuce, one container   $494,626   −$30,277
C  ...loaded heaviest first     $466,851   −$58,052
```

At $0.33/lb air. The rate matters: at $0.25 the same figures are −$60,848 and
−$88,623.

## Rules the model holds to

| | |
|---|---|
| Container | 18 floor spaces. Same price full or empty. |
| Stacking | Two pallets share a space if their combined cases fit. The limit is a toggle — 66 is one full pallet, but the records contain real pairs of 72 and 78. |
| Billable weight | net product + 1 lb carton (0.5 lb LR/WR) + 40 lb pallet. Both carriers weigh it this way. |
| Lettuce | never at the pallet rate — cold chain. Container or plane only. |
| Costco | one product to a pallet. Everyone else may be combined. |
| Shared pallets | a pallet split across two POs appears twice in the detail. It is only ever shared within one customer, so Shorts counts it once. AP and AP - Foodland are one customer under two names. |
| Mixed pallets | how full one is, is the sum of each product's share — its cases over what a pallet of that product holds. A pallet of 10 LF, 15 LR, 2 LW and 16 WR is 0.28 + 0.27 + 0.06 + 0.29 = 93% full. `data.json` carries the per-product split as `mix`. |
| Trucks | driver time and diesel only. We own them either way, so the purchase cancels. |
| Maui, Kauai, Farm Link | loose chill only — a freed container space is no use to them. |
| JR, JW | overridden to 16 lb a case. Sold by the piece; `sales_product` says 14. |
| LF | 36 cases a pallet, matching `sales_product`. It was briefly carried at 43, read off a mixed pallet that held 43 cases across four products. Pure LF pallets top out at exactly 36. |
| 2026-07-20 | books both containers for 9 pallets. Data error, dropped. |

## Rates

```
container  $1,633 one way    drayage $250    loading $200 (cucumber only)
pallet     $0.126 / lb       air     $0.33 / lb
driver     $25 / h           diesel  $6 / gal at 11 mpg
port       28 mi, 2.0 h      airport 76 mi, 2.5 h
```

Rates live in `shared.js` as defaults and in the browser's `localStorage` once
edited, so changing one never needs a rebuild. `data.json` holds only the
shipping history — no prices at all.

## Rebuilding

```
python3 build.py         # data.json + templates -> index.html.  Offline.
python3 extract.py       # prod -> data.json.  Needs the network.
```

**Two scripts, and most of the time you want the first.** `build.py` reads only
what is on disk, so editing a template or a rate and rebuilding cannot change
the numbers. `extract.py` re-queries prod, and **the query is not pinned to a
date range** — it takes every sailing day in `sales_palletization_v` carrying 10
or more container spaces, so each pull can widen the window and move every figure
on the page. Run it when you want that, not by reflex.

`extract.py` needs `SUPABASE_ACCESS_TOKEN`.

The annualiser is derived as 104 ÷ ship_days for the same reason. It used to be
hardcoded and silently inflated every figure by 8% when a 13th sailing appeared.

Current window: 13 sailings, 2026-07-17 → 08-28.

## Files

```
index.html               the viewer — open this
build.py                 data.json + templates -> index.html.  Offline.
extract.py               prod -> data.json.  The only thing that hits the network.
data.json                the shipping history
shared.js                settings, scenario engine, truck maths, 3D renderer
style.css                one stylesheet
templates/               one per tab; extract.py merges them into index.html
FINDINGS.md              the questions the model cannot answer on its own
docs/                    a data-defect write-up, and an unrelated brief
```

## Where this lives

Source for the Freight tab of the dash, at `dash/freight/src`. `python3 build.py`
writes the published page directly to `dash/freight/index.html` — the file the
hub iframes — so there is no copy step. Run `extract.py` first when the shipping
history needs refreshing; it needs prod credentials, `build.py` does not.

History before 2026-09-03 is in `lfeder/farm-freight-model`, which still
exists on GitHub and is no longer built from.
