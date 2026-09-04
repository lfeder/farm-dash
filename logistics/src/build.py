"""Build index.html from legs.csv, reference.json, orders.json and viewer/.

Three files, split by how often they change rather than by what they describe:

    legs.csv        A SNAPSHOT of the schedule, which lives in Postgres --
                    pack_journey and pack_journey_leg. Pulled on every build and
                    committed either way, so the diff shows what changed and the
                    page has something to draw with no network. Only ACTIVE
                    journeys are written to it.

                    The built page reads Postgres itself on every load, and the
                    Logistics tab edits it in place, so a schedule change needs
                    no build -- a refresh is enough. This snapshot is the
                    fallback, and running the build is how it gets caught up.
    reference.json  Two halves. Hand-edited: the step order and its place-pair
                    overrides, the test-and-hold recipes, the cutting days. And
                    generated, alongside legs.csv: `hours` and `sailings` are
                    snapshots of pack_freight_gate and pack_sailing.
    orders.json     Pulled, not typed. Cases and pounds on order by destination,
                    and the pack line's case counts, copied out of the freight
                    model's data.json. Refresh it there, not here.

    python3 build.py

Reads Postgres over the anon key, which is public; needs no credentials.
"""
import csv
import io
import datetime
import json
import os
import re
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
ICONS = {"box", "truck", "plane", "ship", "depot", "store", "clock"}


def die(f, msg):
    sys.exit("%s: %s" % (f, msg))


REF = json.load(open(os.path.join(HERE, "reference.json")))

# ── the schedule, out of Postgres ─────────────────────────────────────
# The four pack_ tables are the schedule. legs.csv and the hours/sailings blocks
# in reference.json are SNAPSHOTS of them: pulled on every build, written back
# either way so the change shows up in the diff rather than only on the screen,
# and used by the page only when the database cannot be reached.
#
# Only ACTIVE journeys are written to the snapshot. A journey that has been
# switched off is off, and a fallback that quietly put it back would be the bug
# this table was added to fix.
#
# Reads over the anon key, which is public: this needs no credentials.
SUPA = {"url": "https://zdvpqygiqavwpxljpvqw.supabase.co",
        "key": "sb_publishable_HaoyPZbNIUxKPnwCh3iI3Q_1NIiWGgv"}


def supa(table, query):
    req = urllib.request.Request(
        "%s/rest/v1/%s?%s" % (SUPA["url"], table, query),
        headers={"apikey": SUPA["key"], "Authorization": "Bearer " + SUPA["key"]})
    with urllib.request.urlopen(req, timeout=20) as fh:
        return json.loads(fh.read().decode("utf-8"))


LIVE = "select=*&is_deleted=eq.false&order=display_order.asc"


def pull():
    """The four tables, as (journeys, legs, gates, sailings)."""
    return (supa("pack_journey", LIVE),
            supa("pack_journey_leg",
                 "select=*&is_deleted=eq.false&order=step_order.asc"),
            supa("pack_freight_gate", LIVE),
            supa("pack_sailing", LIVE))


def grid_csv(journeys, legs, steps):
    """The journeys as the grid the page's fallback reader already understands.

    Keeping the snapshot in the sheet's own shape means the offline path is the
    reader that has always been there, rather than a second one written to be
    exercised only when something is broken.
    """
    live = [j for j in journeys if j.get("is_active")]
    mine = {}
    for g in legs:
        mine.setdefault(g["pack_journey_id"], {})[g["step"]] = g
    out = [["Crop"] + [j.get("crop") or "" for j in live],
           ["FOB"] + [j.get("fob") or "" for j in live],
           ["Mode"] + [j.get("transport") or "" for j in live],
           ["Hold"] + [j.get("hold") or "" for j in live]]
    for st in steps:
        row = [st]
        for j in live:
            g = mine.get(j["id"], {}).get(st)
            if not g:
                row.append("")
                continue
            a, b = g["start_time"][:5], g["end_time"][:5]
            row.append("%s %s-%s%s" % (DOW[g["start_dow"]], a,
                                       "" if g["end_dow"] == g["start_dow"]
                                       else DOW[g["end_dow"]] + " ", b))
        out.append(row)
    buf = io.StringIO()
    csv.writer(buf).writerows(out)
    return buf.getvalue()


try:
    journeys, legs, gates, sailings_db = pull()
    steps_order = [x["step"] for x in REF.get("steps", {}).get("order", [])]
    with open(os.path.join(HERE, "legs.csv"), "w", newline="") as fh:
        fh.write(grid_csv(journeys, legs, steps_order))
    REF["hours"] = [{"place": g["id"], "days": g["days"], "open": g["open_time"][:5],
                     "close": g["close_time"][:5], "note": g.get("notes") or ""}
                    for g in gates]
    REF["sailings"] = [{"route": x["route"], "departs": x.get("departs") or "",
                        "arrives": x.get("arrives") or "",
                        "connects": x.get("connects") or "",
                        "note": x.get("notes") or ""} for x in sailings_db]
    with open(os.path.join(HERE, "reference.json"), "w") as fh:
        json.dump(REF, fh, indent=1)
        fh.write("\n")
    off = sum(1 for j in journeys if not j.get("is_active"))
    print("pulled %d journeys (%d switched off), %d legs, %d gates, %d sailings"
          % (len(journeys), off, len(legs), len(gates), len(sailings_db)))
except Exception as e:
    print("database unreachable (%s) — using the committed snapshot" % e)


def hhmm(s, f, where):
    m = re.match(r"^(\d{1,2}):(\d{2})$", (s or "").strip())
    if not m:
        die(f, "%s: expected a time like 06:00, got %r" % (where, s))
    h, mn = int(m.group(1)), int(m.group(2))
    if h > 23 or mn > 59:
        die(f, "%s: %r is not a time" % (where, s))
    return h + mn / 60.0


def days_mask(spec, f, where):
    """'Mon-Fri', 'Sun-Sat', or 'Mon; Wed; Fri'."""
    mask = [0] * 7
    spec = (spec or "").strip()
    if not spec:
        die(f, "%s: no days given" % where)
    for part in re.split(r"[;,]", spec):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = [x.strip()[:3].title() for x in part.split("-", 1)]
            if a not in DOW or b not in DOW:
                die(f, "%s: %r is not a day range" % (where, part))
            i, j, k = DOW.index(a), DOW.index(b), DOW.index(a)
            while True:
                mask[k] = 1
                if k == j:
                    break
                k = (k + 1) % 7
        else:
            d = part[:3].title()
            if d not in DOW:
                die(f, "%s: %r is not a day" % (where, part))
            mask[DOW.index(d)] = 1
    return mask


# ── hours, keyed by place ────────────────────────────────────────────────────
# A window belongs to a place, and the place names in legs.csv are the same
# names, so there is one namespace and a leg's lane picks up its own hours.
#
# Only GATES live here -- somebody else's door, which opens when they say. Our
# own places are in `sites` below and carry no window at all, because the
# viewer treats a place with no window as one that can never be late: it is the
# absence of a row here, not a value in it, that turns the gating off.
hours, hours_order = {}, []
for r in REF.get("hours", []):
    p = (r.get("place") or "").strip()
    if not p:
        continue
    if p in hours:
        die("reference.json", "hours: %r appears twice" % p)
    hours[p] = {"place": p, "days": days_mask(r.get("days"), "reference.json", p),
                "open": hhmm(r.get("open"), "reference.json", p),
                "close": hhmm(r.get("close"), "reference.json", p),
                "note": (r.get("note") or "").strip()}
    hours_order.append(p)

# ── sites: the places we own ────────────────────────────────────────────────
# Name and note only. A leg between two of them is bounded by the schedule in
# legs.csv and by nothing else, which is the point: when the packhouse works is
# a decision, not a door, so it does not belong in a table of other people's
# opening times where it would drift into four copies of one fact.
sites = []
for r in REF.get("sites", {}).get("places", []):
    p = (r.get("place") or "").strip()
    if not p:
        continue
    if p in hours:
        die("reference.json", "sites: %r is also a gate in hours" % p)
    sites.append({"place": p, "note": (r.get("note") or "").strip()})

sailings = []
for r in REF.get("sailings", []):
    if not (r.get("route") or "").strip():
        continue
    sailings.append({"route": r["route"].strip(), "departs": (r.get("departs") or "").strip(),
                     "arrives": (r.get("arrives") or "").strip(),
                     "connects": (r.get("connects") or "").strip(),
                     "note": (r.get("note") or "").strip()})

# ── what gets embedded ──────────────────────────────────────────────────────
# The schedule goes in as the CSV text it already is. The viewer turns rows
# into journeys, from the sheet when it can reach it and from this snapshot
# when it cannot, so those rules live in exactly one place and this file no
# longer has an opinion about them.
legs_text = open(os.path.join(HERE, "legs.csv")).read()

data = json.load(open(os.path.join(HERE, "orders.json")))
ref = {"hours": [hours[p] for p in hours_order], "sites": sites, "sailings": sailings,
       "hold": REF.get("hold", {}), "steps": REF.get("steps", {}),
       "start_days": str(REF.get("start_days") or "0"),
       "packed_from": REF.get("packed_from", {})}

shell = open(os.path.join(HERE, "viewer", "index.html")).read()
out = (shell
       .replace("/*__LEGS__*/", json.dumps(legs_text))
       .replace("/*__SUPA__*/", json.dumps(SUPA))
       .replace("/*__BUILT__*/",
                datetime.datetime.now().astimezone().strftime("%Y-%m-%d %H:%M %Z"))
       .replace("/*__REF__*/", json.dumps(ref, separators=(",", ":")))
       .replace("/*__DATA__*/", json.dumps(data, separators=(",", ":")))
       .replace("<style>/*__CSS__*/</style>",
                "<style>\n%s\n</style>" % open(os.path.join(HERE, "viewer", "style.css")).read())
       .replace("/*__JS__*/", open(os.path.join(HERE, "viewer", "app.js")).read()))

# Published one level up, which is the path the dash hub iframes. Built
# straight there rather than built here and copied by hand: a forgotten copy
# meant the dash showed a schedule nobody was running any more.
path = os.path.normpath(os.path.join(HERE, os.pardir, "index.html"))
with open(path, "w") as fh:
    fh.write(out)

print("%d gates with hours, %d sites, %d sailings" % (len(hours), len(sites), len(sailings)))
print("%d order rows, %s to %s" % (len(data["sales"]), data["window"]["first"], data["window"]["last"]))
print("wrote %s (%.0f KB)" % (path, len(out) / 1024))
