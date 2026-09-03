# Logistics flow diagram — brief for Austin

## What this is for

Two things, and they are different jobs.

**One: boil our logistics schedule down to one page.** It is genuinely complex —
two harvest days in each half of the week, two barge sailings, three
destinations, two products, a transship through Honolulu, and a food-safety hold
running underneath all of it. Nobody can hold it in their head, and it is
written down nowhere. We want a single page that states what our week is.

**Two: model where we were against where we can get to.** Two states, not four:

```
  where we were     barge  +  48 h hold
  where we get to   air    +   4 h hold
```

These are not separate arguments to be weighed against each other. They are one
move, and the model exists to size it.

The measure throughout is **harvest to customer** — how much of the product's
shelf life is left when it lands. Not transit time, not cost. Cost is modelled
elsewhere; this is about days.

## The part that is not a proposal

**We are already on a 4-hour hold.** We have been for a while. But we never
reworked the delivery schedule around it, so Costco Kona is still being served
on the old 4-to-5-day cadence — on-island, where the hold was the only thing
holding us up, and where a 4h hold means we could deliver the next day.

That is not a decision to make. It is days of shelf life being given away every
week because nobody sat down and redrew the schedule. **The one-page schedule is
how we stop doing that**, and it is the first thing the diagram should make
obvious.

## The operation

**Harvest is four days a week — Sunday, Monday, Wednesday, Thursday.** The
test-and-hold clock starts about **2 PM** on each of them.

Test and hold gates **delivery, not departure**. Product ships either way; it
cannot be handed to the customer until the hold clears.

### Barge — Young Brothers, out of Kawaihae

```
Kawaihae → Honolulu     departs Tue PM, Fri PM     arrives Wed AM, Sat AM
Honolulu → Kahului      Tue sailing makes Wed boat, Fri sailing makes Mon boat
```

Cargo is available in Honolulu the **next business day after arrival** — which is
why HFA collects Thursday and Monday rather than Wednesday and Saturday. On
Maui, HFA delivers the day after the Kahului arrival.

```
OAHU
harvest Sun/Mon → Tue PM sail → Wed AM Honolulu → Thu HFA → Fri AM customer
harvest Wed/Thu → Fri PM sail → Sat AM Honolulu → Mon HFA → Tue AM customer

MAUI
harvest Sun/Mon → Tue PM sail → Wed Honolulu → Wed boat → Thu AM Kahului → Fri customer
harvest Wed/Thu → Fri PM sail → Sat Honolulu → Mon boat → Tue AM Kahului → Wed customer
```

Worth drawing carefully, because it is counter-intuitive: **Maui is not always
later than Oahu.** On the Tuesday sailing both land Friday. Only on the Friday
sailing does Maui fall a day behind, Wednesday against Tuesday.

### Air — Aloha Air Cargo, out of Kona

We have a negotiated arrangement: **drop in Kona, arrives Oahu the same day.**
Two legs are not yet pinned down and are toggles below.

### On-island

Our own trucks. No carrier leg at all, so the hold is the only gate — which is
exactly why the Kona schedule above should already have changed.

### Which harvest day goes to whom

We harvest **twice in each half of the week** — Sunday and Monday feed the
Tuesday sailing, Wednesday and Thursday feed the Friday sailing. Both days'
product leaves on the same boat, so **the first day's harvest arrives a day
older than the second day's.**

That makes the split a real decision, and the model needs to show it:

- **Off-island cannot move until the boat goes**, whichever day it was cut. So a
  Sunday cut sits an extra day before it even sails.
- **On-island can go the moment the hold clears** — a Sunday cut can be with a
  local customer on Monday.

Which points at giving **the earlier harvest to local customers and the later
harvest to off-island**, so the product that has to wait for a boat is the
freshest we have when it starts waiting. That is our reading, not a rule we
have tested — the diagram should let us try it both ways and see.

Every customer therefore needs a bucket: **local or off-island, first-day or
second-day harvest.** Page 2 is where that lives.

## Two pages, two jobs

This is not one screen. It is two, and they are used at different moments.

**Page 1 — the lettuce model.** This is job two. A working screen: toggles,
three destinations, air against barge and 4h against 48h. We sit in front of it,
move the toggles, and decide. Only lettuce, because only lettuce has the choice.

**Page 2 — the delivery schedule.** This is job one. Both products, all three
islands, every delivery day, on one page. No toggles, or at most a single switch
between "today" and "what we decided". Nothing to argue with — it is the
statement of what our week is.

Build page 1 first. Page 2 is only worth drawing once we know what goes on it.

---

# Page 1 — the lettuce model

**Three destination panels — on-island, Oahu, Maui — visible together.**
Time runs left to right across the days of the week. Each panel shows the chain:

```
greenhouses → [air or barge] → HFA → final customers
```

The **test-and-hold bar** overlays the timeline, starting 2 PM on the harvest day
and running 4 or 48 hours. Where it ends after the freight arrives, that is the
delay — and that is the whole idea. It should be impossible to miss.

**Cucumbers and lettuce are different products, not two versions of the same
picture:**

- **Cucumbers** — barge only, no test and hold. One flow. Never flown.
- **Lettuce** — the full comparison.

So cucumbers are a small reference panel; lettuce is the screen.

### Toggles (page 1)

| toggle | options | default |
|---|---|---|
| **Scenario** | where we were (barge + 48h) / where we get to (air + 4h) | where we were |
| Harvest day | Sun / Mon / Wed / Thu | Mon |
| Farm → Kona | same day / next day | *unconfirmed* |
| Kona → Oahu | same day | confirmed |
| Kona → Maui | same day / next day | *unconfirmed* |
| Recovery at destination | same day / next morning | next morning |

The scenario toggle moves transport and hold **together** — they are one move,
not two dials. If it is cheap to also break them apart, that is useful for
sanity-checking, but it is not what the page is for.

Everything recalculates from these. **Harvest-to-customer days should be the one
number that stands out on each panel** — that is what the meeting will look at.

### Still open on page 1 — build them as toggles, do not hard-code

1. **Farm → Kona: same day as harvest, or next morning?** Harvest is 2 PM. This
   sets the best case: air is either a 0-1 day lane or a 1-2 day one.
2. **Kona → Maui same day?** If yes, Maui and Oahu share an air timeline. If it
   routes via Honolulu overnight, Maui air is +1.

---

# Page 2 — the delivery schedule

One page, no argument on it. **Both products, all three islands, every delivery
day.** The highest-level statement of what our week is.

Shape it as a week across the top and the destinations down the side, with each
cell saying what lands there and when it was cut:

```
                 Mon    Tue    Wed    Thu    Fri    Sat    Sun
  On-island       .              .            .
  Oahu                   .                    .
  Maui                          .             .
```

Each mark carries the product, **which harvest day it was cut on**, and the days
elapsed. Cucumbers and lettuce want to be distinguishable at a glance — colour or
shape, not a legend anyone has to read.

This page is also where the harvest-day buckets live: every customer sits in one,
**local or off-island, first-day or second-day cut**. Getting that allocation
visible is half the reason for the page.

This page has no toggles beyond, at most, one switch between **today** and
**what we decided on page 1**, so the change is visible as a before and after.

Draw this after page 1 has settled. Its content depends on the decision.

## Constraints

- **Each page is one screen.** Everything above the fold, no scrolling between
  panels. If page 1 will not fit, drop detail from the chain, never a
  destination.
- The audience is us, not a customer. Density over polish.
- Days of the week, not dates. This is a repeating weekly cycle.

## Sources

- [YB sailing schedules](https://htbyb.com/sailing-schedules/)
- [YB cargo acceptance and availability](https://htbyb.com/wp-content/uploads/Cargo-Delivery-and-Availability-Information-Sheet-Eff-05.02.22-All-Islands-WEBv1.pdf)
- [Aloha Air Cargo interisland](https://www.alohaaircargo.com/hawaii-interisland/)
