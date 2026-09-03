"use strict";
// Loaded by every page as a plain script, so these declarations are globals.
// Nothing here runs at load beyond building constants -- the page supplies
// its own D and settings and calls in.
  // ---- shared settings ----------------------------------------------------
  // Every page reads and writes one store, so a rate changed anywhere is the
  // rate used everywhere. Storage can be unavailable (a file:// origin, blocked
  // site data) -- each page falls back to the same defaults, so that is safe.
  // Bump when a default changes meaningfully. A saved value always beats a
  // default, so without this an old rate sits in the browser and quietly
  // overrides the new one -- v14 is the air rate moving from $0.25 to $0.33.
  // v16 adds palSailing, the one lettuce-pallets-a-sailing figure both the
  // Lettuce and Trucks pages read.
  // The cost of a bump is that any rate deliberately edited resets once.
  var STORE_KEY = 'freight-settings-v16';

  var DEFAULTS = {
    containerRate: 1633, drayage: 250, loadCost: 200, palletRate: 0.126, airRate: 0.33,
palletTare: 40, caseBox: 1, caseBoxRetail: 0.5,
    // Replaced at load with 104 / ship_days -- see loadSettings. Only a fallback
    // for a dataset that does not say how many sailings it holds.
    annualize: 8.67,
    stackCases: 66,
    // Box truck fleet. A part-full run is counted as the fraction of a truck
    // it fills, not rounded up: it still has room for whatever else is going,
    // so charging a whole empty run overstates it. Both pages read this rule.
    capLarge: 8, nLarge: 2,
    // Lettuce pallets a sailing -- the figure the Lettuce page argues from and
    // the Trucks page flies. One number so the two pages cannot disagree.
    palSailing: 17,
        driverRate: 25, fuelPrice: 6, truckMpg: 11,
    // Both round trip, so miles and minutes are quoted the same way. Stored as
    // each-way until v15, which is why the store key moved.
    bargeDriveRT: 60, bargeWait: 60, bargeMiles: 28,
    airDriveRT: 120, airLoad: 30, airMiles: 76,
    localRunsPerWeek: 2,
  };
  // `spaces` is what a container physically holds, not a lever: no page offers
  // it as an input and a stale stored value must not override it.
  var FIXED = { spaces: 18 };

  // The loading charge is a toggle rather than a free number. It is the same
  // money in every option -- each ships exactly one cucumber container -- so it
  // changes no comparison between them. What it does change is what a pound
  // through the container costs, and that decides whether a 12 lb case can pay
  // for a space. KR sits within 2% of that line, so the answer moves with it.
  var LOAD_STEPS = [0, 100, 200];

  // Cases a single floor space can hold once two pallets are stacked in it. 66
  // is one full pallet and is the conservative reading; the palletization
  // records contain real pairs of 72 and 78, so the true limit is not settled.
  var STACK_STEPS = [66, 72, 78];

  // Render a toggle of fixed choices into `host`, calling back when it moves.
  function stepToggle(host, V, key, steps, label, onChange) {
    if (!host) return;
    host.className = 'seg sm';
    host.innerHTML = steps.map(function (n) {
      return '<a href="#" data-step="' + n + '"' +
        (V[key] === n ? ' class="on"' : '') + '>' + label(n) + '</a>';
    }).join('');
    host.onclick = function (e) {
      var a = e.target.closest ? e.target.closest('a[data-step]') : null;
      if (!a) return;
      e.preventDefault();
      V[key] = parseFloat(a.getAttribute('data-step'));
      saveSettings(V);
      stepToggle(host, V, key, steps, label, onChange);
      onChange();
    };
  }

  // Render that toggle into `host`, calling back when it moves. Kept here so
  // every page that offers it offers the same one.
  function loadToggle(host, V, onChange) {
    if (!host) return;
    host.className = 'seg sm';
    host.innerHTML = LOAD_STEPS.map(function (n) {
      return '<a href="#" data-load="' + n + '"' +
        (V.loadCost === n ? ' class="on"' : '') + '>$' + n + '</a>';
    }).join('');
    host.addEventListener('click', function (e) {
      var a = e.target.closest ? e.target.closest('a[data-load]') : null;
      if (!a) return;
      e.preventDefault();
      V.loadCost = parseFloat(a.getAttribute('data-load'));
      saveSettings(V);
      loadToggle(host, V, onChange);
      onChange();
    });
  }

  function loadSettings(D) {
    var v = {};
    Object.keys(DEFAULTS).forEach(function (k) { v[k] = DEFAULTS[k]; });
    try {
      var saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      Object.keys(DEFAULTS).forEach(function (k) {
        if (typeof saved[k] === 'number' && isFinite(saved[k]) && saved[k] >= 0) v[k] = saved[k];
      });
    } catch (e) { /* defaults stand */ }
    Object.keys(FIXED).forEach(function (k) { v[k] = FIXED[k]; });
    // The barge sails twice a week, so a year is 104 sailings. Deriving the
    // multiplier from the window rather than fixing it means the totals do not
    // inflate when the extract picks up another sailing -- which it does, since
    // the query is not pinned to a date range.
    if (D && D.ship_days > 0) v.annualize = 104 / D.ship_days;
    return v;
  }
  function saveSettings(v) {
    try {
      var out = {};
      Object.keys(DEFAULTS).forEach(function (k) { out[k] = v[k]; });
      localStorage.setItem(STORE_KEY, JSON.stringify(out));
    } catch (e) { /* nothing to do */ }
  }

  // ---- box truck fleet ----------------------------------------------------
  // Truck-trips needed to move n pallets.
  function truckRuns(v, n) {
    return n <= 0 ? 0 : n / v.capLarge;
  }

  // Pallets stack on a truck deck exactly as they do in a container space, so a
  // run carries capLarge stacked positions rather than capLarge pallets. Pair the
  // shortest with the tallest that will take it and count what is left.
  // The loose-chill freight is left exactly as it was loaded -- Maui, Kauai and
  // Farm Link are not the freight this is trying to move, and restacking them
  // rearranges a truck for no gain. Everything else pairs.
  function truckPositions(v, rows, looseSet) {
    var keep = 0, c = [];
    rows.forEach(function (r) {
      if (looseSet && looseSet[r.customer]) keep++; else c.push(r.cases);
    });
    c.sort(function (a, b) { return a - b; });
    var lo = 0, hi = c.length - 1, n = 0;
    while (lo < hi) {
      if (c[lo] + c[hi] <= v.stackCases) { n++; lo++; hi--; } else { n++; hi--; }
    }
    if (lo === hi) n++;
    return keep + n;
  }

  function truckRunsFor(v, rows, looseSet) {
    return rows.length ? truckRuns(v, truckPositions(v, rows, looseSet)) : 0;
  }

  // Cost of one truck-trip: the driver's hours plus the diesel burnt. The
  // truck itself is a fixed annual cost, spread over every run it makes.
  function runVariable(v, kind) {
    var mins = kind === 'air'
      ? v.airDriveRT + v.airLoad
      : v.bargeDriveRT + v.bargeWait;
    var miles = (kind === 'air' || kind === 'local') ? v.airMiles : v.bargeMiles;
    return (mins / 60) * v.driverRate + (v.truckMpg > 0 ? miles / v.truckMpg : 0) * v.fuelPrice;
  }

  // The Monday and Thursday Costco Kona run goes to the same place as the
  // airport and takes the same time, so it is costed as an airport run.
  function runHours(v, kind) {
    return kind === 'air' || kind === 'local'
      ? (v.airDriveRT + v.airLoad) / 60
      : (v.bargeDriveRT + v.bargeWait) / 60;
  }




  // ---- 3D container -------------------------------------------------------
  // Class name is deliberately not "f": the settings panels already own that one
  // (background, padding, display:flex), and once every page is merged into one
  // document that rule lands on every cube face and paints them the card colour.
  function face(w, h, tf, fill, extra) {
    return '<div class="pf" style="width:' + w + 'px;height:' + h + 'px' +
      ';margin-left:' + (-w / 2) + 'px;margin-top:' + (-h / 2) + 'px' +
      ';transform:' + tf + ';background:' + fill + (extra || '') + '"></div>';
  }

  // A cuboid centred on its own origin, drawn from six faces.
  //
  // Each face is grown by a pixel so neighbours overlap at the edges. Cut to
  // exact size they meet on a shared line, and subpixel rounding under rotation
  // leaves a hairline of background showing along every corner.
  // `edge` outlines every face. Used on the blocks in a space that holds more
  // than one pallet: two colours of the same family stacked read as one tall
  // lump otherwise, and where one pallet ends and the next begins is the whole
  // point of drawing them separately.
  function cuboid(w, h, d, colour, edge) {
    var top = shade(colour, 1.18), side = shade(colour, 0.82), front = colour;
    var E = 1, W = w + E, H = h + E, Dp = d + E;
    var ln = edge ? ';box-shadow:inset 0 0 0 2px rgba(12,16,20,0.85)' : '';
    return face(W, H, 'translateZ(' + (d / 2) + 'px)', front, ln) +
           face(W, H, 'rotateY(180deg) translateZ(' + (d / 2) + 'px)', front, ln) +
           face(Dp, H, 'rotateY(90deg) translateZ(' + (w / 2) + 'px)', side, ln) +
           face(Dp, H, 'rotateY(-90deg) translateZ(' + (w / 2) + 'px)', side, ln) +
           face(W, Dp, 'rotateX(90deg) translateZ(' + (h / 2) + 'px)', top, ln) +
           face(W, Dp, 'rotateX(-90deg) translateZ(' + (h / 2) + 'px)', side, ln);
  }

  function shade(hex, k) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return hex;
    var n = parseInt(m[1], 16);
    var c = [n >> 16, (n >> 8) & 255, n & 255].map(function (v) {
      return Math.max(0, Math.min(255, Math.round(v * k)));
    });
    return 'rgb(' + c.join(',') + ')';
  }

  // A space is judged on whether it could have been fuller, not on what crop is
  // in it: green is a space doing its job, red is one we could have filled and
  // did not, amber is short with nothing available to pair it with.

  // A space is judged on whether it could have been fuller, not on what crop is
  // in it. Green is a space doing its job. Red is a stackable pallet that
  // another stackable was there to pair with. Yellow is short: too tall to take
  // anything on top, but not a full pallet either -- the shape with nowhere to
  // go.
  // Maui, Kauai and Farm Link ride a truck at any fill, so a short pallet of
  // theirs is not an opportunity -- it is drawn grey rather than scored.
  var SLOT_HEX = { full: '#3f8f4f', stack: '#b3341c', short: '#d9a83c', loose: '#7b8288' };

  // Eighteen floor spaces, two across and nine deep. Returns the markup and a
  // tally of how each space was judged.
  function container3d(spaces, totalSpaces, palFrac, geom, stackFrac, looseSet, palColour,
                       palLabel) {
    var CELL_W = geom.w, CELL_D = geom.d, GAP = geom.gap, FULL_H = geom.h;
    var bySpace = {};
    spaces.forEach(function (x) { bySpace[x.space] = x; });

    // A pallet is judged on its own height, not on whether the drawing managed to
    // find it a partner: what it pairs with may be sitting on a box truck, which
    // this drawing cannot see. Under the stack limit it can take another pallet
    // on top; between there and a full pallet it cannot; at the top it is full.
    //
    // Judged per pallet rather than per space, so a short pallet stays short-
    // coloured and short-sized once it is stacked onto something in the optimised
    // arrangement. `palColour` carries the left-hand drawing's verdicts across so
    // restacking never repaints a pallet.
    var chosen = {};
    if (palColour) {
      Object.keys(palColour).forEach(function (k) { chosen[k] = palColour[k]; });
    }
    function classify(r) {
      var k = r.pallet_number;
      if (chosen[k]) return chosen[k];
      var cls;
      if (looseSet && looseSet[r.customer]) cls = 'loose';
      else if (palFrac(r) >= 0.999) cls = 'full';
      else if (stackFrac && stackFrac(r) <= 1) cls = 'stack';
      else cls = 'short';
      chosen[k] = cls;
      return cls;
    }

    var html = '', tally = { full: 0, stack: 0, short: 0, loose: 0, used: 0, empty: 0 };

    // One continuous floor rather than a plinth under each space: the container
    // has a single deck, and 18 separate slabs read as 18 different levels.
    var rows = Math.ceil(totalSpaces / 2);
    // The deck sits a hair BELOW the pallets and overhangs them: without that,
    // its top face is coplanar with all the pallet bottoms and its edges with the
    // outer pallet faces, and CSS 3D -- which sorts whole elements, not pixels --
    // draws the slab over them, so the pallets read as sunk into the floor.
    //
    // Thin: too much thickness and the slab's own front face stands in front of
    // the pallets behind it and swallows their bottoms.
    var FLOOR_H = 2.5, DROP = 1, LIP = 8;
    html += '<div class="pw" style="transform:translate3d(0px,' +
      (FULL_H / 2 + DROP + FLOOR_H / 2) + 'px,0px)">' +
      cuboid(2 * CELL_W + GAP + LIP, FLOOR_H,
             rows * CELL_D + (rows - 1) * GAP + LIP, '#c9d2d7') + '</div>';

    for (var i = 0; i < totalSpaces; i++) {
      var x = ((i % 2) - 0.5) * (CELL_W + GAP);
      var z = (Math.floor(i / 2) - (rows - 1) / 2) * (CELL_D + GAP);
      var slot = bySpace[i + 1];

      if (!slot) { tally.empty++; continue; }
      tally.used++;

      // Biggest on the floor, the rest stacked on it, each drawn to its own
      // share of a full pallet -- so a space holding two shorts is two blocks,
      // not one solid one.
      var pals = slot.rows.slice().sort(function (a, b) { return b.cases - a.cases; });
      var stacked = pals.length > 1;   // outline the blocks so the pair reads as two
      var base = FULL_H / 2;   // deck level, in this axis y grows downward
      for (var p = 0; p < pals.length; p++) {
        var r = pals[p];
        var cls = classify(r);
        tally[cls]++;
        var h = FULL_H * Math.max(0.12, Math.min(1, palFrac(r)));
        html += '<div class="pw" style="transform:translate3d(' + x + 'px,' +
          (base - h / 2) + 'px,' + z + 'px)">' +
          cuboid(CELL_W - 4, h, CELL_D - 4, SLOT_HEX[cls], stacked) + '</div>';
        // A pallet that moves carries a number so the eye can find the same one
        // again in the arrangement next to it. On the front face, not the lid:
        // the bigger pallet of a stacked pair sits on the floor, and a number on
        // its lid is hidden under whatever is standing on it.
        var tag = palLabel && palLabel[r.pallet_number];
        if (tag) {
          // On the lid and on the outward side, so one of them is always facing
          // you: a lid is hidden under whatever is stacked on it, and a side is
          // hidden behind the next pallet along.
          var lw = CELL_W - 6, ld = CELL_D - 6;
          var num = function (w, hh, tf, fs) {
            return '<div class="pw" style="transform:translate3d(' + x + 'px,' +
              (base - h / 2) + 'px,' + z + 'px) ' + tf + '">' +
              '<div class="palnum" style="width:' + w + 'px;height:' + hh + 'px' +
              ';margin-left:' + (-w / 2) + 'px;margin-top:' + (-hh / 2) + 'px' +
              ';font-size:' + fs + 'px">' + tag + '</div></div>';
          };
          var lidFs = Math.max(9, Math.round(Math.min(CELL_W, CELL_D) * 0.42));
          var sideFs = Math.max(9, Math.round(Math.min(CELL_D * 0.42, h * 0.6)));
          // lid
          html += num(lw, ld, 'translateY(' + (-h / 2 - 0.6) + 'px) rotateX(90deg)', lidFs);
          // outward side: away from the centre line, so the left column shows its
          // left face and the right column its right
          var outward = (i % 2) === 0 ? -90 : 90;
          html += num(ld, h, 'rotateY(' + outward + 'deg) translateZ(' +
            (CELL_W / 2 - 1.4) + 'px)', sideFs);
        }
        // A hair of air between stacked pallets, so the join is a gap and not just
        // a change of colour -- two blocks of the same verdict abut otherwise.
        base -= h + (stacked ? 1.5 : 0);
      }
    }
    return { html: html, tally: tally, palColour: chosen };

  }

  // Drag to turn. Kept here so every page that draws a container behaves alike.
  function wire3dDrag(stage, rig, view) {
    var apply = function () {
      rig.style.transform = 'rotateX(' + view.rx + 'deg) rotateY(' + view.ry + 'deg)';
    };
    var down = function (e) {
      var p = e.touches ? e.touches[0] : e;
      view.drag = { x: p.clientX, y: p.clientY, rx: view.rx, ry: view.ry };
      stage.classList.add('grabbing');
    };
    var move = function (e) {
      if (!view.drag) return;
      var p = e.touches ? e.touches[0] : e;
      view.ry = view.drag.ry + (p.clientX - view.drag.x) * 0.4;
      view.rx = Math.max(-85, Math.min(10, view.drag.rx - (p.clientY - view.drag.y) * 0.3));
      apply(); e.preventDefault();
    };
    var up = function () { view.drag = null; stage.classList.remove('grabbing'); };
    stage.addEventListener('mousedown', down);
    stage.addEventListener('touchstart', down, { passive: true });
    window.addEventListener('mousemove', move);
    window.addEventListener('touchmove', move, { passive: false });
    window.addEventListener('mouseup', up);
    window.addEventListener('touchend', up);
    apply();
  }

  function legend3d(t) {
    return '<div class="legend">' +
      '<span><i style="background:' + SLOT_HEX.full + '"></i>Full &mdash; ' + t.full + '</span>' +
      (t.stack ? '<span><i style="background:' + SLOT_HEX.stack + '"></i>Stackable &mdash; ' +
        t.stack + '</span>' : '') +
      '<span><i style="background:' + SLOT_HEX.short + '"></i>Short &mdash; ' + t.short + '</span>' +
      (t.loose ? '<span><i style="background:' + SLOT_HEX.loose + '"></i>Loose chill only &mdash; ' +
        t.loose + '</span>' : '') +
      '</div>';
  }

  // ---- space notes --------------------------------------------------------

  // Questions asked of one floor space, keyed date|container|space. They hang
  // off the space rather than the page, so the same note shows wherever that
  // space is drawn -- the lettuce container is tabulated on two pages.
  var SPACE_NOTES = {
    '2026-07-17|cucumber|4': 'Costco allow 1 layer?',
    '2026-07-21|cucumber|4': 'Can we stack this high?',
    '2026-07-21|cucumber|8': 'Can we stack this high?',
    '2026-07-31|cucumber|17': 'Why is the product null?',
    '2026-08-04|lettuce|14': 'This is too high.',
    '2026-08-07|cucumber|9': 'Why is the product null?',
    '2026-08-07|cucumber|10': 'Why is the product null?',
    '2026-08-07|cucumber|12': 'Why is the product null?',
    '2026-08-07|cucumber|15': 'Why is the product null?'
  };

  // ---- floor spaces -------------------------------------------------------

  // What a floor space could weigh if it carried a full pallet of the product
  // actually in it: its own max cases, at its own case weight, plus the pallet.
  // Measuring against this rather than a fixed 1,162 takes the product mix out,
  // so what is left is how much of the space was really used.
  // Cases a pallet of a code holds at full height, from the product sheet.
  function maxCasesFn(D) {
    var m = D.pallet_cases || {};
    return function (code) { return (m[code] && m[code].full) || 66; };
  }

  // Cases at which a pallet is still short enough to take another on top.
  // LW is 0: those pallets never stack.
  function shortCasesFn(D) {
    var m = D.pallet_cases || {};
    return function (code) { return m[code] ? m[code].short : 0; };
  }

  // The share of a pallet a row takes up, with every product measured against
  // its OWN cases-per-pallet and the shares added. A pallet of 5 LF (36 to a
  // pallet) beside 33 LR/WR (56 to a pallet) is 0.73 of a pallet -- reading the
  // whole 38 cases against the first code in the string, as this did, called it
  // a full pallet and then some. Rows without a mix fall back to their first
  // code, which for a single product is the same arithmetic it always was.
  function palletFracFn(D) {
    var MAX = maxCasesFn(D);
    return function (r) {
      var mix = r.mix, f = 0, any = false, k;
      if (mix) for (k in mix) { if (mix[k]) { any = true; f += mix[k] / MAX(k); } }
      return any ? f : (r.cases || 0) / MAX((r.prods || '').split('/')[0]);
    };
  }

  // Same idea against the stack limit: how much of "short enough to take another
  // pallet on top" this row uses. Infinity when any product in it never stacks
  // (LW), because one tray that cannot be stacked on settles the whole pallet.
  function stackFracFn(D) {
    var SHORT = shortCasesFn(D);
    return function (r) {
      var mix = r.mix, f = 0, any = false, k, s;
      if (mix) {
        for (k in mix) {
          if (!mix[k]) continue;
          any = true; s = SHORT(k);
          if (!s) return Infinity;
          f += mix[k] / s;
        }
      }
      if (any) return f;
      s = SHORT((r.prods || '').split('/')[0]);
      return s ? (r.cases || 0) / s : Infinity;
    };
  }

  // A pallet can host or be part of a stack only if it is at or under the short
  // count for its product. Anything taller is a full-height pallet however few
  // cases it carries.
  function isStackable(shortCases, r) {
    return r.cases <= shortCases((r.prods || '').split('/')[0]);
  }

  // Pallet detail keyed by sailing and container.
  function detailIndex(D) {
    var by = {};
    (D.detail || []).forEach(function (r) {
      var k = r.dt + '|' + r.container;
      (by[k] || (by[k] = [])).push(r);
    });
    return by;
  }

  function spacePotential(V, palFrac, rows) {
    var cases = 0, lbs = 0, frac = 0;
    rows.forEach(function (r) {
      cases += r.cases; lbs += r.product_lbs; frac += palFrac(r);
    });
    if (!cases || frac <= 0) return 0;
    // What is here, scaled up to a whole pallet of the same mix. For a single
    // product this is the old cases-per-pallet x case weight exactly; for a mix
    // it no longer has to pick one code's pallet count to speak for the rest.
    return (lbs + cases * V.caseBox) / frac + V.palletTare;
  }

  // Grouped by floor space, since a space is what a container sells.
  function spacesOf(V, palFrac, DETAIL, key) {
    var by = {};
    (DETAIL[key] || []).forEach(function (r) {
      (by[r.space] || (by[r.space] = [])).push(r);
    });
    return Object.keys(by).sort(function (a, b) { return a - b; }).map(function (sp) {
      var rows = by[sp];
      var cases = rows.reduce(function (a, r) { return a + r.cases; }, 0);
      var lbs = rows.reduce(function (a, r) { return a + r.product_lbs; }, 0);
      return {
        space: +sp, rows: rows, cases: cases,
        billable: lbs + cases * V.caseBox + rows.length * V.palletTare,
        potential: spacePotential(V, palFrac, rows)
      };
    });
  }

  // ---- one sailing's container, drawn and tabulated -------------------------
  // Built here rather than on a page because two pages want the same thing: a
  // 3D of the container above a row per pallet. `notes` is looked up per space
  // so a page can annotate one without the others knowing about it.
  // The space-by-space table on its own, so a page can lay the drawing and the
  // table out however it likes rather than taking the pair side by side.
  function spaceTable(V, ctx, key, notes) {
    var spaces = ctx.spacesOfKey(key);
    if (!spaces.length) return '';
    var body = spaces.map(function (x) {
      var pct = x.potential > 0 ? 100 * x.billable / x.potential : 0;
      return x.rows.map(function (r, i) {
        return '<tr>' +
          (i === 0 ? '<td class="num" rowspan="' + x.rows.length + '">' + x.space + '</td>' : '') +
          '<td style="text-align:left">' + r.pallet_number + '</td>' +
          '<td style="text-align:left">' + (r.customer || '&mdash;') + '</td>' +
          '<td>' + r.prods + '</td>' +
          '<td class="num">' + r.cases + '</td>' +
          (i === 0 ? '<td class="num" rowspan="' + x.rows.length + '">' +
              '<span class="pair"><b>' + fmtLbs(x.billable) + '</b><i>/</i><s>' +
              fmtLbs(x.potential) + '</s></span></td>' +
            '<td class="num' + (pct < 85 ? ' win' : '') + '" rowspan="' + x.rows.length + '">' +
              pct.toFixed(0) + '%</td>' +
            '<td style="text-align:left" rowspan="' + x.rows.length + '">' +
              ((notes || {})[key + '|' + x.space] || '') + '</td>' : '') +
          '</tr>';
      }).join('');
    }).join('');
    return '<table class="wttbl">' +
      '<thead><tr><th>Space</th><th style="text-align:left">Pallet</th>' +
      '<th style="text-align:left">Customer</th>' +
      '<th>Product</th><th>Cases</th><th>Billable /<br>could hold</th><th>Used</th>' +
      '<th style="text-align:left">Notes</th>' +
      '</tr></thead><tbody>' + body + '</tbody></table>';
  }

  // One sailing as one table: the container's spaces, then whatever the caller
  // appends for the trucks under a break row. No pallet name -- the number is a
  // warehouse label, not something a reader of this page needs -- so the columns
  // stay narrow enough for the table to sit in half the width.
  function loadTable(V, ctx, key, notes, tailRows) {
    return loadTableOf(V, ctx.spacesOfKey(key), key, notes, tailRows);
  }

  function loadTableOf(V, spaces, key, notes, tailRows) {
    if (!spaces.length && !tailRows) return '';
    var body = spaces.map(function (x) {
      var pct = x.potential > 0 ? 100 * x.billable / x.potential : 0;
      var note = (notes || {})[key + '|' + x.space] || '';
      return x.rows.map(function (r, i) {
        return '<tr>' +
          (i === 0 ? '<td class="num" rowspan="' + x.rows.length + '">' + x.space + '</td>' : '') +
          '<td style="text-align:left">' + (r.customer || '&mdash;') + '</td>' +
          '<td>' + r.prods + '</td>' +
          '<td class="num">' + r.cases + '</td>' +
          (i === 0 ? '<td class="num" rowspan="' + x.rows.length + '">' +
              '<span class="pair"><b>' + fmtLbs(x.billable) + '</b><i>/</i><s>' +
              fmtLbs(x.potential) + '</s></span></td>' +
            '<td class="num' + (pct < 85 ? ' win' : '') + '" rowspan="' + x.rows.length + '">' +
              pct.toFixed(0) + '%</td>' : '') +
          '</tr>';
      }).join('') +
      // The note runs under the space it is about, across the whole table, so it
      // reads as a sentence rather than as something crushed into a column.
      (note ? '<tr class="noterow"><td></td><td colspan="5">' + note + '</td></tr>' : '');
    }).join('');
    return '<table class="wttbl loadtbl">' +
      '<colgroup><col class="c-sp"><col><col class="c-prod">' +
      '<col class="c-cases"><col class="c-bill"><col class="c-used"></colgroup>' +
      '<thead><tr><th class="num">Sp</th><th style="text-align:left">Customer</th>' +
      '<th>Prod</th><th>Cases</th><th>Billable /<br>could hold</th><th>Used</th>' +
      '</tr></thead><tbody>' + body + (tailRows || '') + '</tbody></table>';
  }

  // The arrangement missedMoves arrived at, in the shape spacesOf gives -- so the
  // same drawing and the same table can render what would have shipped as easily
  // as what did.
  function spacesFromPacked(V, ctx, packed) {
    return packed.map(function (x, i) {
      var rows = [];
      x.pals.forEach(function (p) { p.rows.forEach(function (r) { rows.push(r); }); });
      var cases = rows.reduce(function (a, r) { return a + r.cases; }, 0);
      var lbs = rows.reduce(function (a, r) { return a + r.product_lbs; }, 0);
      return {
        space: i + 1, rows: rows, cases: cases,
        billable: lbs + cases * V.caseBox + x.pals.length * V.palletTare,
        potential: spacePotential(V, ctx.PAL_FRAC, rows)
      };
    });
  }

  function space3dHost(key) {
    return '<div class="wt3d" id="wt3d-' + key.replace('|', '-') + '"></div>';
  }

  function spaceDetail(V, ctx, key, notes) {
    var table = spaceTable(V, ctx, key, notes);
    if (!table) return '';
    return '<div class="wtwrap">' + space3dHost(key) + table + '</div>';
  }

  // Draw into the placeholder spaceDetail left behind. Separate because the
  // element only exists once the caller has put the markup in the document.
  // The drawing's own size, so a page that has to fit one beside another can ask
  // for a smaller one rather than scaling the finished picture.
  var GEOM = { w: 40, d: 34, gap: 4, h: 46 };
  function scaleGeom(f) {
    return { w: GEOM.w * f, d: GEOM.d * f, gap: GEOM.gap * f, h: GEOM.h * f };
  }

  // Draw any set of spaces into any host. Two callers now: the container as it
  // shipped, and the arrangement it could have shipped in.
  function mount3dInto(hostId, V, ctx, spaces, totalSpaces, views, viewKey, geom, stackFrac,
                       palColour, palLabel) {
    var host = document.getElementById(hostId);
    if (!host) return;
    var out = container3d(spaces, totalSpaces, ctx.PAL_FRAC, geom || GEOM, stackFrac, ctx.LOOSE,
      palColour, palLabel);
    host.innerHTML = '<div class="stage"><div class="rig"></div></div>' + legend3d(out.tally);
    var stage = host.querySelector('.stage'), rig = host.querySelector('.rig');
    rig.innerHTML = out.html;
    wire3dDrag(stage, rig, views[viewKey] || (views[viewKey] = { rx: -22, ry: -32, drag: null }));
    return out.palColour;
  }

  function mountSpaceDetail(V, ctx, key, views, geom, palColour, palLabel) {
    return mount3dInto('wt3d-' + key.replace('|', '-'), V, ctx, ctx.spacesOfKey(key),
      V.spaces, views, key, geom, ctx.STACK_FRAC, palColour, palLabel);
  }

  // ---- before and after ---------------------------------------------------
  // One pallet, however many detail rows it has: a pallet shared between two POs
  // appears twice and is still one thing to load.
  function palletsOf(rows) {
    var by = {}, order = [];
    rows.forEach(function (r) {
      var k = r.pallet_number;
      if (!by[k]) { by[k] = { n: k, cases: 0, lb: 0, rows: [], po: r.po,
                              customer: r.customer, space: r.space }; order.push(k); }
      by[k].cases += r.cases;
      by[k].rows.push(r);
    });
    return order.map(function (k) { return by[k]; });
  }

  // Lay a set of pallets into floor spaces the way the model says they should
  // be loaded: pair the shortest with the tallest that will take it, so the
  // fewest spaces carry the most.
  function layOut(V, pals) {
    var sorted = pals.slice().sort(function (a, b) { return a.cases - b.cases; });
    var lo = 0, hi = sorted.length - 1, spaces = [];
    while (lo < hi) {
      if (sorted[lo].cases + sorted[hi].cases <= V.stackCases) {
        spaces.push([sorted[hi], sorted[lo]]); lo++; hi--;
      } else { spaces.push([sorted[hi]]); hi--; }
    }
    if (lo === hi) spaces.push([sorted[lo]]);
    return spaces;
  }

  // What the sailing looked like, and what it would look like once the moves and
  // swaps the model found are made. The after state is derived from missedMoves
  // rather than worked out again, so the tables can never disagree with the
  // Could fit, lb saved and Potential savings figures on the row above them.
  function beforeAfter(V, ctx, d, splitPo) {
    var key = d.dt + '|cucumber';
    var ctrRows = ctx.DETAIL[key] || [];
    var boxRows = ctx.DETAIL[d.dt + '|box'] || [];
    if (!ctrRows.length && !boxRows.length) return null;

    var before = { spaces: ctx.spacesOfKey(key), box: palletsOf(boxRows) };
    var m = ctx.missedMoves(d, splitPo);
    if (!m) return { before: before, after: null };

    var goesIn = {}, comesOut = {};
    m.pallets.forEach(function (r) { goesIn[r.pallet_number] = 1; });
    m.swaps.forEach(function (x) {
      goesIn[x.from.pallet_number] = 1;
      comesOut[x.into.n] = 1;
    });

    var ctrPals = palletsOf(ctrRows).filter(function (p) { return !comesOut[p.n]; });
    var boxPals = palletsOf(boxRows);
    boxPals.forEach(function (p) { if (goesIn[p.n]) ctrPals.push(p); });
    var truckPals = boxPals.filter(function (p) { return !goesIn[p.n]; })
      .concat(palletsOf(ctrRows).filter(function (p) { return comesOut[p.n]; }));

    return { before: before, after: { spaces: layOut(V, ctrPals), box: truckPals } };
  }

  // ---- the box trucks -----------------------------------------------------
  // A truck takes capLarge pallets and nothing stacks on a truck -- the pallets
  // ride the deck side by side -- so a run is a flat deck of at most capLarge,
  // and a sailing needs as many runs as its spillover fills. Drawn with the same
  // renderer as the container: pass the run's own capacity as the space count
  // The deck stacks exactly as a container space does -- same limit, and the
  // loose-chill freight stacks too.
  // Flat by default: the trucks as they actually went out, one pallet a position,
  // in the order the caller sorted them -- which keeps the loose-chill freight
  // together. `stack` is for the optimised load, where pallets are paired the way
  // a container space pairs them, shortest onto tallest.
  function truckLoads(V, rows, stack, looseSet) {
    var stacks;
    if (stack) {
      // Loose-chill pallets keep their own position and their place in the
      // order: they are not what this is trying to move.
      var c = [];
      stacks = [];
      rows.forEach(function (r) {
        if (looseSet && looseSet[r.customer]) stacks.push([r]); else c.push(r);
      });
      c.sort(function (a, b) { return a.cases - b.cases; });
      var lo = 0, hi = c.length - 1;
      while (lo < hi) {
        if (c[lo].cases + c[hi].cases <= V.stackCases) { stacks.push([c[hi], c[lo]]); lo++; hi--; }
        else { stacks.push([c[hi]]); hi--; }
      }
      if (lo === hi) stacks.push([c[lo]]);
    } else {
      stacks = rows.map(function (r) { return [r]; });
    }

    var out = [], run = [];
    stacks.forEach(function (pals) {
      run.push({ space: run.length + 1, rows: pals });
      if (run.length === V.capLarge) { out.push(run); run = []; }
    });
    if (run.length) out.push(run);
    return out;
  }

  function truckDetail(V, ctx, dt, rows, tag, stack) {
    if (!rows.length) return '';
    var runs = truckLoads(V, rows, stack, ctx.LOOSE);
    return '<div class="truck3d" id="tk3d-' + dt + (tag || '') + '">' +
      runs.map(function () {
        return '<div class="truckbay">' +
          '<div class="wt3d"><div class="stage"><div class="rig"></div></div></div></div>';
      }).join('') + '</div>';
  }

  function mountTruckDetail(V, ctx, dt, rows, views, geom, tag, palColour, palLabel, stack) {
    var host = document.getElementById('tk3d-' + dt + (tag || ''));
    if (!host) return;
    var runs = truckLoads(V, rows, stack, ctx.LOOSE);
    Array.prototype.forEach.call(host.querySelectorAll('.wt3d'), function (box, i) {
      if (!runs[i]) return;
      var out = container3d(runs[i], V.capLarge, ctx.PAL_FRAC,
        geom || GEOM, ctx.STACK_FRAC, ctx.LOOSE, palColour, palLabel);
      palColour = out.palColour;
      var stage = box.querySelector('.stage'), rig = box.querySelector('.rig');
      rig.innerHTML = out.html;
      var k = 'box|' + dt + (tag || '') + '|' + i;
      wire3dDrag(stage, rig, views[k] || (views[k] = { rx: -22, ry: -32, drag: null }));
    });
    return palColour;
  }

  function fmtLbs(n) { return Math.round(n).toLocaleString('en-US'); }

  // ---- repacking within the rules -----------------------------------------
  // Costco alone will not take two products on one pallet. Everyone else may be
  // combined, so an alternative can rebuild their pallets freely; Costco's
  // remainders are structural rather than waste.
  function noMix(customer, group) {
    return (group || '') === 'Costco';
  }

  // Floor spaces a day's cucumbers need if repacked as well as the rules allow:
  // whole pallets first, then the leftovers paired two to a space where they are
  // short enough.
  function spacesNeeded(rows, maxCpp, shortCases) {
    var g = {};
    rows.forEach(function (r) {
      var code = (r.prods || '').split('/')[0];
      var key = noMix(r.customer, r.grp)
        ? (r.customer + '|' + code)          // Costco: one product to a pallet
        : (r.customer + '|mixed');           // anyone else may be combined
      var x = g[key] || (g[key] = { cases: 0, code: code });
      x.cases += r.cases;
    });
    var whole = 0, shorts = 0;
    Object.keys(g).forEach(function (k) {
      var x = g[k], F = maxCpp(x.code), S = shortCases(x.code);
      whole += Math.floor(x.cases / F);
      var rem = x.cases % F;
      if (rem > 0) { if (rem <= S) shorts++; else whole++; }
    });
    return { spaces: whole + Math.ceil(shorts / 2), whole: whole, shorts: shorts };
  }


  // ---- the annual model ----------------------------------------------------
  // The cost of a year, scenario by scenario. Lifted out of the Annual page so
  // the Findings page quotes the same arithmetic rather than a second copy of
  // it: one engine, one set of numbers, wherever they are shown.
  //
  // Everything closes over the caller's live settings object, so an edited rate
  // flows through without rebuilding.
  var CONTAINERS = { lettuce: 1, cucumber: 1 };
  var DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  function buildModel(V, D) {
    var ROWS = D.rows;

    // Costco Maui and Kauai are not on the barge the containers ride, and Farm
    // Link's orders go loose chill. A container slot is no use to any of them,
    // so they are held apart from genuine spillover.
    var LOOSE = {};
    (D.loose_only || []).forEach(function (c) { LOOSE[c] = 1; });
    // ---- shape the history --------------------------------------------------
    // Pallets per floor space, per crop. Short pallets stack two to a space, so
    // pallet counts overstate how much container a crop actually consumes; every
    // counterfactual converts through this rather than through pallet counts.
    var stack = (function () {
      var a = {};
      ROWS.forEach(function (r) {
        if (!CONTAINERS[r.container]) return;              // box trucks don't stack
        var s = a[r.crop] || (a[r.crop] = { p: 0, s: 0 });
        s.p += r.pallets; s.s += r.spaces;
      });
      var out = {};
      Object.keys(a).forEach(function (c) { out[c] = a[c].s > 0 ? a[c].p / a[c].s : 1; });
      return out;
    })();

    var DETAIL = detailIndex(D);
    var MAX_CPP = maxCasesFn(D);
    var SHORT_CPP = shortCasesFn(D);
    var PAL_FRAC = palletFracFn(D);
    var STACK_FRAC = stackFracFn(D);
    function spacesOfKey(key) { return spacesOf(V, PAL_FRAC, DETAIL, key); }


    // Costco Maui and Kauai are not on the barge the containers ride, and Farm
    // Link's orders go loose chill. A container slot is no use to any of them, so
    // they are held apart from genuine spillover.
    var BOX = {};
    (D.box || []).forEach(function (r) { BOX[r.dt] = r; });

    var FILL = {};
    (D.fill || []).forEach(function (r) {
      (FILL[r.dt] || (FILL[r.dt] = {}))[r.container] = r;
    });

    var DAYS = (function () {
      var m = {};
      ROWS.forEach(function (r) {
        var d = m[r.dt] || (m[r.dt] = {
          dt: r.dt,
          Lettuce: { pallets: 0, lbs: 0, cases: 0, std: 0, retail: 0 },
          Cuke:    { pallets: 0, lbs: 0, cases: 0, std: 0, retail: 0 },
          box:     { pallets: 0, lbs: 0, cases: 0, std: 0, retail: 0 },
          boxLettuce: 0,
          containers: {},  // container kinds that actually ran that day
          // Per container, per crop: the lettuce container carries cucumbers too.
          ctr: {}
        });
        var slot = d.ctr[r.container] || (d.ctr[r.container] = {});
        var cell = slot[r.crop] || (slot[r.crop] = { pallets: 0, spaces: 0, lbs: 0, std: 0, retail: 0 });
        cell.pallets += r.pallets; cell.spaces += r.spaces; cell.lbs += r.product_lbs;
        cell.std += r.cases_std || 0; cell.retail += r.cases_retail || 0;
        var c = d[r.crop];
        if (c) {
          c.pallets += r.pallets; c.lbs += r.product_lbs; c.cases += r.cases;
          c.std += r.cases_std || 0; c.retail += r.cases_retail || 0;
        }
        if (r.container === 'box') {
          d.box.pallets += r.pallets; d.box.lbs += r.product_lbs; d.box.cases += r.cases;
          d.box.std += r.cases_std || 0; d.box.retail += r.cases_retail || 0;
          if (r.crop === 'Lettuce') d.boxLettuce += r.pallets;
        } else {
          d.containers[r.container] = 1;
        }
      });
      return Object.keys(m).sort().map(function (k) {
        var d = m[k];
        d.dow = DOW[new Date(k + 'T12:00:00').getDay()];
        d.fill = FILL[k] || {};
        return d;
      });
    })();

    // Billable weight is what a carrier actually weighs: the product, the carton
    // it sits in, and the pallet under it. case_net_weight covers only the first.
    function boxLbs(o, f) {
      f = f === undefined ? 1 : f;
      return (o.std * V.caseBox + o.retail * V.caseBoxRetail) * f;
    }
    function billable(o, f) {
      f = f === undefined ? 1 : f;
      return (o.lbs + o.pallets * V.palletTare) * f + boxLbs(o, f);
    }
    // Only the cucumber container costs us labour to load; the lettuce container
    // does not.
    function perContainer(kind) {
      return V.containerRate + V.drayage + (kind === 'cucumber' ? V.loadCost : 0);
    }
    // What a sailing's cucumbers need if repacked as well as the rules allow.
    // Measured in floor spaces, since that is what a container sells.
    function cukeSpacesNeeded(d) {
      var rows = (D.detail || []).filter(function (r) {
        return r.dt === d.dt && r.crop !== 'Lettuce';
      });
      return spacesNeeded(rows, MAX_CPP, SHORT_CPP);
    }

    function cukeCasesPerPallet(d) {
      return d.Cuke.pallets ? d.Cuke.cases / d.Cuke.pallets : 66;
    }

    // ---- scenarios ----------------------------------------------------------
    // Each returns the cost split for one ship day, plus `work`: the lines the
    // expanded row shows, so the table can never drift from the arithmetic.
    function current(d) {
      var kinds = Object.keys(d.containers);
      var n = kinds.length;
      var freight = kinds.reduce(function (a, k) { return a + perContainer(k); }, 0);
      var bill = billable(d.box);
      // Flat: this is the model as it runs today, and today the decks are not
      // stacked. What stacking would save shows up in the optimised arrangement.
      var runs = truckRuns(V, d.box.pallets);
      return {
        containers: n,
        freight: freight,
        air: 0,
        pallet: bill * V.palletRate,
        box: runs * runVariable(V, 'barge'),
        runs: runs,
        hours: runs * runHours(V, 'barge'),
      };
    }

    // All lettuce flies and the cucumbers take one container, the rest going at
    // the pallet rate. A second container never earns its keep: it holds 19
    // cucumber pallets so two need 38, and the busiest sailing in the window
    // carried 37.
    function airLettuce(d) {
      var C = d.Cuke;
      var n = C.cases <= 0 ? 0 : 1;
      // Repacked within the rules, then poured into the container's 18 spaces.
      var need = cukeSpacesNeeded(d);
      var overSpaces = Math.max(0, need.spaces - n * V.spaces);
      var share = need.spaces > 0 ? overSpaces / need.spaces : 0;
      var overCases = C.cases * share;
      var cpp = cukeCasesPerPallet(d);
      var over = Math.ceil(overCases / cpp);          // pallets that spill
      var fits = C.pallets - over;
      var overBill = billable(C, share);
      var airBill = billable(d.Lettuce);
      var airRuns = truckRuns(V, d.Lettuce.pallets);
      var bargeRuns = truckRuns(V, over);
      return {
        containers: n,
        freight: n * perContainer('cucumber'),
        air: airBill * V.airRate,
        pallet: overBill * V.palletRate,
        box: airRuns * runVariable(V, 'air') + bargeRuns * runVariable(V, 'barge'),
        runs: airRuns + bargeRuns,
        hours: airRuns * runHours(V, 'air') + bargeRuns * runHours(V, 'barge')
      };
    }


    // Repack a sailing's cucumbers within the rules and return the SPACES that
    // makes, heaviest first. Whole pallets first, then the leftovers paired two
    // to a space where both are short enough; Costco keeps one product a pallet.
    //
    // Sorting by weight is the whole point: the container sells 18 spaces at a
    // flat price, so the only thing that decides what a pound costs through it
    // is how many pounds those 18 spaces carry.
    function repackSpaces(rows) {
      var g = {};
      rows.forEach(function (r) {
        var code = (r.prods || '').split('/')[0];
        var key = noMix(r.customer, r.grp) ? (r.customer + '|' + code)
                                           : (r.customer + '|mixed');
        var x = g[key] || (g[key] = { cases: 0, code: code, cust: r.customer || '(no customer)' });
        x.cases += r.cases;
      });
      var lbOf = function (cases, code) {
        return cases * (netOf(code) + V.caseBox) + V.palletTare;
      };
      var spaces = [], shorts = [];
      Object.keys(g).forEach(function (k) {
        var x = g[k], F = MAX_CPP(x.code), S = SHORT_CPP(x.code), i;
        for (i = 0; i < Math.floor(x.cases / F); i++) {
          spaces.push({ lb: lbOf(F, x.code), code: x.code, cases: F, pallets: 1,
                        cust: x.cust, kind: 'full' });
        }
        var rem = x.cases % F;
        if (rem > 0) {
          var one = { lb: lbOf(rem, x.code), code: x.code, cases: rem, pallets: 1,
                      cust: x.cust, kind: rem <= S ? 'short' : 'part' };
          if (rem <= S) shorts.push(one); else spaces.push(one);
        }
      });
      // Pair the heaviest shorts together so a paired space is worth the most it
      // can be; an odd one out rides alone.
      shorts.sort(function (a, b) { return b.lb - a.lb; });
      for (var i = 0; i < shorts.length; i += 2) {
        var a = shorts[i], b = shorts[i + 1];
        spaces.push({
          lb: a.lb + (b ? b.lb : 0), cases: a.cases + (b ? b.cases : 0),
          code: a.code + (b ? '+' + b.code : ''), pallets: b ? 2 : 1,
          cust: b ? (a.cust + ' + ' + b.cust) : a.cust,
          kind: b ? 'paired' : 'lone short'
        });
      }
      return spaces.sort(function (a, b) { return b.lb - a.lb; });
    }

    // Net case weight per code, after the extract's overrides.
    var NET = {};
    (D.products || []).forEach(function (p) { NET[p.id] = p.net; });
    function netOf(code) { return NET[code] === undefined ? 16 : NET[code]; }

    // Everything scenario B does, except the container is loaded heaviest space
    // first instead of taking a pro-rata share. What misses the boat is then the
    // lightest freight we have, which is exactly the freight that was never
    // going to pay for a space.
    function heaviestFirst(d) {
      var rows = (D.detail || []).filter(function (r) {
        return r.dt === d.dt && r.crop === 'Cuke';
      });
      var all = repackSpaces(rows);
      var n = all.length ? 1 : 0;
      var take = all.slice(0, n * V.spaces);
      var aboard = take.reduce(function (a, x) { return a + x.lb; }, 0);
      var total = all.reduce(function (a, x) { return a + x.lb; }, 0);
      var overSpaces = Math.max(0, all.length - n * V.spaces);
      var airBill = billable(d.Lettuce);
      var airRuns = truckRuns(V, d.Lettuce.pallets);
      var bargeRuns = truckRuns(V, overSpaces);
      return {
        containers: n,
        freight: n * perContainer('cucumber'),
        air: airBill * V.airRate,
        pallet: Math.max(0, total - aboard) * V.palletRate,
        box: airRuns * runVariable(V, 'air') + bargeRuns * runVariable(V, 'barge'),
        runs: airRuns + bargeRuns,
        hours: airRuns * runHours(V, 'air') + bargeRuns * runHours(V, 'barge'),
        spaces: all, aboard: take, lbAboard: aboard, lbTotal: total
      };
    }

    var SCEN = [
      { id:'A', base:true, name:'Current model',
        desc:'Both containers go out as loaded today &mdash; lettuce container, cucumber container &mdash; and the spillover rides our box trucks at the YB pallet rate.',
        fn:current },
      { id:'B', name:'Air lettuce &middot; one cuke container',
        desc:'All lettuce flies. The cucumbers are repacked into one container\u2019s 18 spaces and whatever will not fit goes loose at the pallet rate. Dropping the container altogether was tested and lost on eleven of twelve sailings \u2014 once it is paid for, the cases inside it are nearly free.',
        fn:airLettuce },
      { id:'C', name:'Air lettuce &middot; heaviest cases first',
        desc:'The same one container, loaded heaviest space first rather than taking whatever turns up. A 16&nbsp;lb case clears the cost of a space; a 12&nbsp;lb case cannot, even on a perfect pallet. So the heavy codes take the 18 spaces and the light ones go loose \u2014 which is what they would have cost anyway.',
        fn:heaviestFirst }
    ];

    // Spaces the cucumber container had spare, in whole pallets of what it carried,
    // and the box pallets that could have used them.
    function missedMoves(d, splitPo) {
      var key = d.dt + '|cucumber';
      var sp = spacesOfKey(key);
      if (!sp.length) return null;
      // Two ways a truck pallet gets aboard, and the second is worth more than
      // the first:
      //
      //   1. it sits on top of a pallet already there, if the two together are
      //      under the height a space allows;
      //   2. the container's OWN pallets are paired up first, which frees whole
      //      floor spaces -- and a freed space takes a pallet of any height.
      //
      // On 07/24 the container sailed full at 18 spaces, four of them holding
      // 18, 24, 18 and 36 cases. Putting the 18s onto the 24 and the 36 frees
      // two spaces, and the two 60-case pallets on the trucks that day fit
      // neither on top of anything nor anywhere else without them.
      //
      // Pallets stack across customers -- the records show spaces shared by two
      // different stores -- so only height constrains this.
      var limit = V.stackCases;
      var own = [];
      sp.forEach(function (x) {
        x.rows.forEach(function (r) { own.push({ cases: r.cases, rows: [r] }); });
      });
      own.sort(function (a, b) { return a.cases - b.cases; });

      // Fewest spaces the container's own pallets can occupy: walk in from both
      // ends, pairing the shortest with the tallest that will take it. The pairs
      // are kept, not just counted, so the arrangement this arrives at can be
      // drawn rather than described.
      var lo = 0, hi = own.length - 1, packed = [];
      while (lo < hi) {
        if (own[lo].cases + own[hi].cases <= limit) {
          packed.push({ cases: own[hi].cases + own[lo].cases, pals: [own[hi], own[lo]] });
          lo++; hi--;
        } else {
          packed.push({ cases: own[hi].cases, pals: [own[hi]] }); hi--;
        }
      }
      if (lo === hi) packed.push({ cases: own[lo].cases, pals: [own[lo]] });
      var usedSpaces = packed.length;
      // If the repack needs more spaces than the container has, there is no room
      // for anything and the headroom below is imaginary. That happens when the
      // sailing was actually loaded above the stack limit -- 07/21 went out with
      // spaces at 72, 72, 80 and 72, so re-pairing its 22 pallets under a 66-case
      // rule needs 20 spaces, not the 18 it had.
      var overloaded = usedSpaces > V.spaces;
      var freeSpaces = overloaded ? 0 : V.spaces - usedSpaces;
      // Headroom left above the pallets that ended up alone, largest first, each
      // still pointing at the space it belongs to.
      var headroom = packed.filter(function (x) { return x.pals.length === 1; })
        .map(function (x) { return { room: limit - x.cases, space: x }; })
        .sort(function (a, b) { return b.room - a.room; });

      // POs already inside the container -- moving more of those splits nothing.
      // And the same the other way for a swap, whose outgoing pallet joins the
      // trucks.
      var inCtr = {}, onBox = {};
      sp.forEach(function (x) { x.rows.forEach(function (r) { inCtr[r.po] = 1; }); });
      (DETAIL[d.dt + '|box'] || []).forEach(function (r) { onBox[r.po] = 1; });

      // Heaviest first: the point is to move weight off the pallet rate.
      var cands = (DETAIL[d.dt + '|box'] || []).filter(function (r) {
        if (LOOSE[r.customer]) return false;            // cannot ride a container
        return splitPo || !!inCtr[r.po];               // else only POs already aboard
      }).map(function (r) {
        return { r: r, cases: r.cases,
                 lb: r.product_lbs + r.cases * V.caseBox + V.palletTare };
      }).sort(function (a, b) { return b.lb - a.lb; });

      var moved = [], empties = [], took = {};
      // A container loaded above the stack limit cannot be re-paired into the
      // spaces it had, so there is no headroom to give away -- but a swap needs
      // none, and is worked out below regardless.
      if (!overloaded) {
        cands.forEach(function (c) {
          var pal = { cases: c.cases, rows: [c.r], fromBox: true };
          // an empty space already opened, if it can still take this one
          for (var e = 0; e < empties.length; e++) {
            if (empties[e].cases + c.cases <= limit) {
              empties[e].cases += c.cases; empties[e].pals.push(pal);
              moved.push(c.r); took[c.r.pallet_number] = 1; return;
            }
          }
          // the tightest headroom that still fits, so the roomy ones stay open
          for (var i = headroom.length - 1; i >= 0; i--) {
            if (headroom[i].room >= c.cases) {
              headroom[i].space.pals.push(pal);
              headroom[i].space.cases += c.cases;
              headroom.splice(i, 1);
              moved.push(c.r); took[c.r.pallet_number] = 1; return;
            }
          }
          if (freeSpaces > 0) {
            freeSpaces--;
            var fresh = { cases: c.cases, pals: [pal] };
            empties.push(fresh); packed.push(fresh);
            moved.push(c.r); took[c.r.pallet_number] = 1;
          }
        });
      }

      // ---- swaps ------------------------------------------------------------
      // A container space is a flat price and a truck pallet is charged by the
      // pound, so a light pallet aboard while a heavier one rides the trucks is
      // money left on the table: trade their places and the difference comes off
      // the pallet rate. Nothing about the container changes -- same spaces, same
      // price -- so a swap needs no free space and works even on a sailing that
      // went out over the stack limit. 07/21 is the case: six full KR pallets at
      // 898 lb rode the container while full KW and JW pallets at 1,162 lb rode
      // the trucks.
      //
      // Only a pallet sitting alone in its space can be swapped, since anything
      // stacked has a partner whose height the incoming pallet would have to
      // respect as well.
      var alone = [];
      sp.forEach(function (x) {
        var pals = {};
        x.rows.forEach(function (r) {
          var p = pals[r.pallet_number] ||
                  (pals[r.pallet_number] = { n: r.pallet_number, cases: 0, lb: V.palletTare,
                                             po: r.po, customer: r.customer, prods: r.prods,
                                             rows: [] });
          p.cases += r.cases;
          p.rows.push(r);
          p.lb += r.product_lbs + r.cases * V.caseBox;
        });
        var k = Object.keys(pals);
        if (k.length === 1) alone.push(pals[k[0]]);
      });
      alone.sort(function (a, b) { return a.lb - b.lb; });        // lightest out first

      var pool = cands.filter(function (c) { return !took[c.r.pallet_number]; });
      var swaps = [];
      alone.forEach(function (a) {
        if (!splitPo && !onBox[a.po]) return;    // its PO would end up on both
        for (var i = 0; i < pool.length; i++) {
          var c = pool[i];
          if (c.cases > limit || c.lb <= a.lb) continue;
          swaps.push({ into: a, from: c.r, gain: c.lb - a.lb });
          pool.splice(i, 1);
          return;
        }
      });

      if (!moved.length && !swaps.length) return null;
      var lbs_ = moved.reduce(function (a, r) {
        return a + r.product_lbs + r.cases * V.caseBox + V.palletTare;
      }, 0);
      var swapLbs = swaps.reduce(function (a, x) { return a + x.gain; }, 0);
      // Taking pallets off the trucks can also drop a whole run to the port --
      // a truck carries capLarge pallets whether it is full or not, so the
      // saving is not only the pallet rate on the weight moved.
      var boxNow = DETAIL[d.dt + '|box'] || [];
      var runsSaved = truckRunsFor(V, boxNow, LOOSE) -
        truckRunsFor(V, boxNow.filter(function (r) { return !took[r.pallet_number]; }), LOOSE);
      var runValue = runsSaved * runVariable(V, 'barge');
      // ---- the arrangement this arrives at -----------------------------------
      // On an overloaded sailing there is no repack, so the after state is the
      // load as it actually went out with the swapped pallets exchanged in place.
      // Otherwise it is the packed spaces, newcomers already slotted in.
      var afterSpaces = overloaded
        ? sp.map(function (x) {
            return { cases: x.cases,
                     pals: x.rows.map(function (r) { return { cases: r.cases, rows: [r] }; }) };
          })
        : packed;

      var swapIn = {};
      swaps.forEach(function (x) { swapIn[x.into.n] = x.from; });
      afterSpaces.forEach(function (x) {
        x.pals = x.pals.map(function (p) {
          var r = p.rows[0], inc = r && swapIn[r.pallet_number];
          return inc ? { cases: inc.cases, rows: [inc], fromBox: true } : p;
        });
        x.cases = x.pals.reduce(function (a, p) { return a + p.cases; }, 0);
      });

      // What is left riding the trucks: everything not taken, plus whatever the
      // swaps put off the container.
      var offCtr = {};
      swaps.forEach(function (x) { offCtr[x.from.pallet_number] = x.into; });
      var afterBox = [];
      (DETAIL[d.dt + '|box'] || []).forEach(function (r) {
        if (took[r.pallet_number]) return;
        var out = offCtr[r.pallet_number];
        afterBox.push(out ? out.rows[0] : r);
      });

      return {
        slack: moved.length, pallets: moved,
        lbs: lbs_,
        palletValue: lbs_ * V.palletRate,
        runsSaved: runsSaved, runValue: runValue,
        swaps: swaps, swapLbs: swapLbs, swapValue: swapLbs * V.palletRate,
        value: (lbs_ + swapLbs) * V.palletRate + runValue,
        afterSpaces: afterSpaces, afterBox: afterBox, overloaded: overloaded
      };
    }

    // Run every scenario over every sailing and add it up.
    function totals() {
      return SCEN.map(function (s) {
        var t = { freight: 0, air: 0, pallet: 0, box: 0, containers: 0, runs: 0, hours: 0, days: [] };
        DAYS.forEach(function (d) {
          var r = s.fn(d);
          r.total = r.freight + r.air + r.pallet + r.box;
          t.freight += r.freight; t.air += r.air; t.pallet += r.pallet;
          t.box += r.box; t.containers += r.containers;
          t.runs += r.runs || 0; t.hours += r.hours || 0;
          t.days.push(r);
        });
        // The trucks are owned whichever way we ship, so nothing here charges
        // for them: only the driver time and diesel each scenario causes.
        t.total = t.freight + t.air + t.pallet + t.box;
        return t;
      });
    }

    return {
      ROWS: ROWS, DAYS: DAYS, SCEN: SCEN, totals: totals,
      DETAIL: DETAIL, MAX_CPP: MAX_CPP, SHORT_CPP: SHORT_CPP,
      PAL_FRAC: PAL_FRAC, STACK_FRAC: STACK_FRAC, spacesOfKey: spacesOfKey,
      BOX: BOX, stack: stack, LOOSE: LOOSE,
      billable: billable, boxLbs: boxLbs, perContainer: perContainer,
      cukeSpacesNeeded: cukeSpacesNeeded, cukeCasesPerPallet: cukeCasesPerPallet,
      current: current, airLettuce: airLettuce, heaviestFirst: heaviestFirst,
      repackSpaces: repackSpaces, netOf: netOf, missedMoves: missedMoves
    };
  }
