(function () {
  "use strict";

  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var STORE = 'taskvis.view.v1';

  var ICON = {
    box:   '<path d="M2 5.2 8 2.4l6 2.8v5.6L8 13.6 2 10.8z"/><path d="M2 5.2 8 8l6-2.8M8 8v5.6"/>',
    truck: '<path d="M1 4.5h8.2v6H1z"/><path d="M9.2 6.6h2.6L14.4 9v1.5H9.2z"/><circle cx="4.2" cy="11.6" r="1.5"/><circle cx="11.3" cy="11.6" r="1.5"/>',
    plane: '<path d="M1.6 8.4 14.4 3.6l-3 5.2 1.1 4.4-2.4-1.5-2.2 1.9-.4-3.1z"/>',
    ship:  '<path d="M2.4 9.6h11.2l-1.7 3.8H4.1z"/><path d="M4.3 9.6V5.8h7.4v3.8M8 5.8V3.2"/>',
    depot: '<path d="M1.8 6.8 8 3.4l6.2 3.4v6.4H1.8z"/><path d="M5.6 13.2V9h4.8v4.2"/>',
    store: '<path d="M2 6.4h12v6.8H2z"/><path d="M2 6.4 3.4 3h9.2L14 6.4"/><path d="M6.4 13.2V9.4h3.2v3.8"/>',
    clock: '<circle cx="8" cy="8" r="6"/><path d="M8 4.6V8l2.4 1.6"/>'
  };
  var ICONS = ['box', 'truck', 'plane', 'ship', 'depot', 'store', 'clock'];
  function ico(k) {
    return '<svg class="i" viewBox="0 0 16 16" width="14" height="14" fill="none" ' +
      'stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round">' +
      (ICON[k] || ICON.clock) + '</svg>';
  }

  // ── What a task is ────────────────────────────────────────────────────────
  // A start, a stop, and where it ends up. Both times are typed, in hours from
  // midnight on day 0, so every task carries exactly the same fields and the
  // list is one grid rather than a different set of controls per kind.
  //
  //   { id, name, place, icon, note, s, e, after: [ids] }
  //
  // Nothing is derived from the graph. `after` records what has to happen
  // first, which is what the links are drawn from, but it does NOT push times
  // about: the next start does not have to be the previous stop. A gap is a
  // gap and gets drawn as one; an overlap is two things happening at once,
  // which is often the truth and used to be inexpressible.
  //
  // Opening hours belong to a PLACE, not to a task. Costco receiving is open 4
  // to 11 whether or not anything is driving towards it.

  // ── Reading the schedule ──────────────────────────────────────────────────
  // The Google Sheet is the schedule. legs.csv is the snapshot the build
  // committed beside it, so the page works with no network and the diff shows
  // what changed. A refresh reads the sheet, which means an edit there is on
  // the screen without anyone running a build.
  //
  // This is the ONLY place a row of CSV becomes a journey. The build used to
  // do the same job again in Python; it does not any more, so there is one set
  // of rules and they cannot drift apart.

  function csvRows(text) {
    var rows = [], row = [], cell = '', q = false, i, c;
    text = String(text).replace(/\r\n?/g, '\n');
    for (i = 0; i < text.length; i++) {
      c = text.charAt(i);
      if (q) {
        if (c !== '"') cell += c;
        else if (text.charAt(i + 1) === '"') { cell += '"'; i++; }
        else q = false;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  // Both spellings of every column, so the sheet's headings and the snapshot's
  // read the same and neither has to be rewritten to match the other.
  var COL = {
    'crop': 'crop', 'fob': 'fob', 'transport': 'transport',
    'mode': 'transport', 'hold': 'hold',
    'start day': 'start_day', 'start_day': 'start_day',
    'branch': 'branch', 'leg': 'leg', 'step': 'leg',
    'start location': 'from', 'start_location': 'from',
    'start dt': 's', 'start_dt': 's',
    'end location': 'place', 'end_location': 'place',
    'end dt': 'e', 'end_dt': 'e',
    'icon': 'icon', 'note': 'note'
  };
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  function legRows(text) {
    var rows = csvRows(text), head = -1, i;
    // The sheet keeps its own margins -- blank columns to the left, blank rows
    // above -- so the header is found by what it names rather than by where it
    // sits. Every layout has a leg and a time it starts.
    for (i = 0; i < rows.length && head < 0; i++) {
      var seen = {};
      rows[i].forEach(function (c) { seen[c.trim().toLowerCase()] = 1; });
      if ((seen.leg || seen.step) && seen['start dt']) head = i;
    }
    if (head < 0) throw new Error('no header row naming Leg or Step, and Start dt');
    var keep = [];
    rows[head].forEach(function (h, k) {
      var name = h.trim().toLowerCase();
      if (has(COL, name)) keep.push([k, COL[name]]);
    });
    function got(k) {
      for (var n = 0; n < keep.length; n++) if (keep[n][1] === k) return true;
      return false;
    }
    ['leg', 's', 'e'].forEach(function (k) {
      if (!got(k)) throw new Error('no column for ' + k);
    });
    if (!got('crop') && !got('fob') && !got('transport')) {
      throw new Error('nothing names the journey: needs Crop, FOB or Transport');
    }
    var out = [];
    for (i = head + 1; i < rows.length; i++) {
      var r = rows[i], rec = {};
      keep.forEach(function (pair) { rec[pair[1]] = (r[pair[0]] || '').trim(); });
      if (rec.leg) out.push(rec);
    }
    if (!out.length) throw new Error('no legs under the header');
    return out;
  }

  // ── The grid ──────────────────────────────────────────────────────────────
  // The other shape the sheet comes in, and the one it is moving to: steps down
  // the side in the order the chart draws them, journeys across the top, and a
  // cell saying when that step ran. A blank cell is a step this journey skips,
  // which is the thing a row-per-leg sheet could never show at a glance.
  //
  //   Crop          Lettuce           Lettuce
  //   FOB           140               Off-island
  //   Transport     Air               Barge
  //   Start Day     0                 0
  //   Pack/Store 1  Sun 10:00-14:00   Sun 14:00-18:00
  //   BOL           Sun 18:00-18:30   Mon 18:00-18:30
  //
  // Where each step runs between is not in the sheet at all -- it is the same
  // on every journey, so it lives in reference.json under steps.
  // 'Mode' and 'Transport' both name the same thing about a journey. The
  // second is also the name of a step, which is why the first exists.
  var GRID_KEYS = { 'crop': 'crop', 'fob': 'fob',
                    'transport': 'transport', 'mode': 'transport',
                    'hold': 'hold',
                    'start day': 'start_day', 'start_day': 'start_day' };

  // 'Sun 10:00-14:00' or 'Tue 18:00 - Wed 12:00': the day carries over to the
  // stop unless the stop names one of its own, because most steps finish on
  // the day they start and saying so twice is noise.
  function span(cell, where) {
    var t = String(cell).replace(/[\s\u00a0\u202f]+/g, ' ').trim();
    var m = /^([A-Za-z]+ ?,? ?\d{1,2}:\d{2})\s*[-\u2013]\s*(.+)$/.exec(t);
    if (!m) throw new Error(where + ": expected 'Sun 10:00-14:00', got '" + t + "'");
    var a = dayTime(m[1], where), tail = m[2].trim();
    var b = /^\d{1,2}:\d{2}$/.test(tail)
      ? dayTime(DOW[a.d] + ' ' + tail, where)
      : dayTime(tail, where);
    return [a, b];
  }

  // A place with no hours has no door to be shut.
  var OPEN = null;
  function openOn(place, day) {
    if (!OPEN) {
      OPEN = {};
      ((window.REF || {}).hours || []).forEach(function (h) { OPEN[h.place] = h.days; });
    }
    var d = OPEN[place];
    return !d ? true : !!d[((day % 7) + 7) % 7];
  }

  // The order the sheet lists its steps in. The chart's rows are the sheet's
  // rows, so the sheet is what orders them; reference.json only says where a
  // step goes when the sheet does not mention it.
  var SHEET_ORDER = [];

  function gridRows(text) {
    var rows = csvRows(text), lab = -1, col = 0, i, j;
    // Find the row that names the crop, and the column its labels sit in.
    for (i = 0; i < rows.length && lab < 0; i++) {
      for (j = 0; j < rows[i].length; j++) {
        if (rows[i][j].trim().toLowerCase() === 'crop') { lab = i; col = j; break; }
      }
    }
    if (lab < 0) throw new Error('no row labelled Crop');
    var wide = 0;
    rows.forEach(function (r) { if (r.length > wide) wide = r.length; });

    var steps = (((window.REF || {}).steps || {}).order) || [];
    if (!steps.length) throw new Error('reference.json names no steps');
    var byStep = {};
    steps.forEach(function (st) {
      byStep[String(st.step).toLowerCase()] = st;
      // A step that has been renamed answers to what it used to be called, so
      // the sheet can catch up in its own time instead of losing a row.
      [].concat(st.was || []).forEach(function (old) {
        byStep[String(old).toLowerCase()] = st;
      });
    });

    // One journey per column, read top to bottom. A column that cannot be
    // built is left out and named, rather than taking the other nine with it:
    // one bad cell should cost you one journey, not the whole page.
    SHEET_ORDER = [];
    rows.slice(lab).forEach(function (r) {
      var k = (r[col] || '').trim().toLowerCase();
      if (has(byStep, k) && SHEET_ORDER.indexOf(byStep[k].step) < 0) {
        SHEET_ORDER.push(byStep[k].step);
      }
    });

    var out = [], hurt = [];
    for (j = col + 1; j < wide; j++) {
      try {
        out = out.concat(column(rows, lab, col, j, byStep));
      } catch (err) {
        hurt.push(String((err && err.message) || err));
      }
    }
    if (!out.length) throw new Error(hurt.length ? hurt[0] : 'no journeys in the grid');
    out.hurt = hurt;
    return out;
  }

  function column(rows, lab, col, j, byStep) {
    var out = [];
    var head = {}, legs = [], started = false;
      rows.slice(lab).forEach(function (r) {
        var name = (r[col] || '').trim(), cell = (r[j] || '').trim();
        if (!name) return;
        var key = name.toLowerCase();
        // Transport is both a thing a journey IS and a step it takes, so the
        // identity block is the one above the first step. After that, a label
        // is a step whatever else it also names.
        if (!started && has(GRID_KEYS, key)) { head[GRID_KEYS[key]] = cell; return; }
        if (!has(byStep, key)) return;
        started = true;
        // Named by the steps table, not by the sheet's row label. They are
        // usually the same word; when a step has been renamed they are not,
        // and the canonical one is the one the chart should say.
        if (cell) legs.push({ st: byStep[key], cell: cell, name: String(byStep[key].step) });
      });
      if (!head.crop && !head.fob) return out;
      if (!legs.length) return out;
      var who = [head.crop, head.fob, head.transport].filter(Boolean).join('-');
      var made = legs.map(function (g) {
        var where = who + ' / ' + g.name;
        // Where a step runs between: the same everywhere unless the journey's
        // transport or its customer changes it.
        // The most specific thing that has an answer wins: an island where the
        // step differs by island, a vehicle where it differs by vehicle, and
        // the plain pair where it differs by neither.
        var pl = g.st.places;
        if (g.st.transport && g.st.transport[head.transport]) pl = g.st.transport[head.transport];
        if (g.st.fob && g.st.fob[head.fob]) pl = g.st.fob[head.fob];
        if (!pl) {
          throw new Error(where + ": nowhere to run between for mode '" +
            (head.transport || '') + "', fob '" + (head.fob || '') + "'");
        }
        var t = span(g.cell, where);
        return { name: g.name, from: pl[0], place: pl[1], sticks: g.st.sticks || '',
                 a: t[0].d * 24 + t[0].h, b: t[1].d * 24 + t[1].h };
      });
      made.forEach(function (g) { while (g.b < g.a) g.b += 24; });

      // A journey written once and run on more than one cutting day. The
      // second run is the first one moved along, except where it lands on a
      // shut door -- HFA does not collect at the weekend, 140 does not receive
      // on a Sunday -- and then it waits for the next open day and everything
      // behind it waits with it. That is the whole difference between the two
      // runs, so only one of them is worth typing.
      // The sheet may still name its own; reference.json says what they are
      // when it does not, because every journey said 0, 3 and the barge is not
      // going to start sailing on different days.
      var days = String(head.start_day || (window.REF || {}).start_days || '0')
        .split(/[,;]+/)
        .map(function (x) { return x.trim(); })
        .filter(function (x) { return x !== ''; });
      if (!days.length) days = ['0'];
      var base = +days[0] || 0;
      days.forEach(function (day, n) {
        var shift = (((+day || 0) - base) % 7 + 7) % 7 * 24, push = 0;
        var moved = made.map(function (g) {
          // The written run is what it says it is; only the moved ones are
          // pushed, or typing a Sunday time would quietly get corrected.
          var sa = g.a + shift + push;
          for (var k = 0; n && k < 7 && !openOn(g.place, Math.floor(sa / 24)); k++) {
            sa += 24; push += 24;
          }
          return push;
        });
        // Then backwards, for the steps that cannot be left behind. A box
        // truck has no chilling, so it is loaded immediately before it goes:
        // when the going moves, the loading moves with it, keeping the gap it
        // was written with. The container has chilling and can wait, which is
        // why only one of the two is marked.
        for (var m = made.length - 2; m >= 0; m--) {
          if (made[m].sticks === 'next' && moved[m] < moved[m + 1]) moved[m] = moved[m + 1];
        }
        made.forEach(function (g, m) {
          var sa = g.a + shift + moved[m], sb = g.b + shift + moved[m];
          out.push({ crop: head.crop, fob: head.fob, transport: head.transport,
            hold: head.hold || '', start_day: day, branch: '1', leg: g.name,
            from: g.from, place: g.place,
            s: DOW[Math.floor(sa / 24) % 7] + ' ' + hhmm(sa),
            e: DOW[Math.floor(sb / 24) % 7] + ' ' + hhmm(sb) });
        });
      });
    return out;
  }

  // Su M T W Th F Sa, and the longer forms. A bare S is not accepted: it could
  // be either end of the week and a schedule is not the place to guess.
  var DAY_WORDS = { su: 0, sun: 0, sunday: 0,
    m: 1, mo: 1, mon: 1, monday: 1,
    t: 2, tu: 2, tue: 2, tues: 2, tuesday: 2,
    w: 3, we: 3, wed: 3, wednesday: 3,
    th: 4, thu: 4, thur: 4, thurs: 4, thursday: 4,
    f: 5, fr: 5, fri: 5, friday: 5,
    sa: 6, sat: 6, saturday: 6 };

  function dayTime(spec, where) {
    // Sheets like to paste a narrow no-break space before AM/PM; flatten every
    // kind of space to one before reading.
    var t = String(spec == null ? '' : spec).replace(/[\s\u00a0\u202f]+/g, ' ').trim();
    var m = /^([A-Za-z]+) ?,? +(\d{1,2}):(\d{2})$/.exec(t);
    if (!m) throw new Error(where + ": expected a day and a time like 'Sun, 10:00', got '" + t + "'");
    var w = m[1].toLowerCase();
    if (w === 's') throw new Error(where + ": 'S' could be Sunday or Saturday -- write Su or Sa");
    if (!has(DAY_WORDS, w)) throw new Error(where + ": '" + m[1] + "' is not a day");
    var hh = +m[2], mm = +m[3];
    if (hh > 23 || mm > 59) throw new Error(where + ": '" + t + "' is not a time");
    return { d: DAY_WORDS[w], h: hh + mm / 60 };
  }

  // A leg's icon is read off its name rather than typed, so the sheet stays
  // columns of schedule and a new leg picks up a sensible glyph on its own.
  // Order matters: the first match wins, so the specific rules come before the
  // general. "Costco delivery clearance" is a clearance, not a delivery.
  var ICON_RULES = [
    [/clearance|eligib|submission|paperwork/, 'depot'],
    [/pack/, 'box'],
    [/fl(y|ight)|aloha|air\b/, 'plane'],
    [/sail|barge|boat/, 'ship'],
    [/truck|deliver|pickup|haul|drive|load/, 'truck'],
    [/receiv|store/, 'store']
  ];
  function iconFor(name) {
    var low = String(name || '').toLowerCase();
    for (var i = 0; i < ICON_RULES.length; i++) {
      if (ICON_RULES[i][0].test(low)) return ICON_RULES[i][1];
    }
    return 'clock';
  }

  function slug(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'flow';
  }

  // A journey is defined once and run on more than one cutting day, so the
  // rows group by journey and start day and each group is its own picture.
  function buildFlows(rows) {
    var hours = {};
    ((window.REF || {}).hours || []).forEach(function (h) { hours[h.place] = h; });
    var groups = {}, order = [];
    // Crop, where it is going and how it gets there name the journey; the
    // start day says which run of it this is. Four columns, one picture.
    // The hold belongs in the name: two journeys to the same customer on the
    // same truck are different journeys if one waits six hours and the other
    // waits forty-eight, and they need their own colour and their own label.
    function name(r) {
      return [r.crop, r.fob, r.transport, r.hold]
        .filter(function (v) { return v; }).join('-') || 'Journey';
    }
    rows.forEach(function (r) {
      var key = name(r) + '\u0000' + (r.start_day || '0');
      if (!has(groups, key)) { groups[key] = []; order.push(key); }
      groups[key].push(r);
    });
    return order.map(function (key) {
      var rs = groups[key], jn = name(rs[0]);
      var where0 = jn + ' / start day ' + (rs[0].start_day || '0');
      // The cutting day is the anchor, and every time is counted forward from
      // it. Taking the first leg's day instead worked only while the first
      // step happened on the cut: cucumbers are cut on a Sunday and first
      // written down on the Monday, and the picture called itself Mon/Tue.
      var sd = parseInt(rs[0].start_day, 10);
      var anchor = isNaN(sd) ? dayTime(rs[0].s, where0).d : ((sd % 7) + 7) % 7;
      var branches = [], tasks = [];
      rs.forEach(function (r) {
        var where = where0 + ' / ' + r.leg;
        function at(spec) {
          var dt = dayTime(spec, where);
          return ((dt.d - anchor + 7) % 7) * 24 + dt.h;
        }
        var br = (r.branch || '1').trim() || '1';
        if (branches.indexOf(br) < 0) branches.push(br);
        var ic = (r.icon || '').toLowerCase();
        // The lane is the step, not the place. The sheet's rows and the
        // chart's rows are then the same list, and every journey is measured
        // against the same seven -- which is what makes two threads
        // comparable at a glance. Where it physically is rides along on `at`,
        // because that is what has opening hours.
        tasks.push({ id: 't' + tasks.length, name: r.leg, branch: br,
          place: rowOf(r.leg), at: r.place || 'Somewhere', atFrom: r.from || 'Somewhere',
          s: at(r.s), e: at(r.e),
          icon: ICONS.indexOf(ic) < 0 ? iconFor(r.leg) : ic,
          note: r.note || '' });
      });
      // ── The hold ────────────────────────────────────────────────────
      // Test and hold is the same chain of steps on every journey, so it is
      // written once in reference.json and grown onto each one from the
      // moment packing ends. Branch 2 rows in the sheet are dropped rather
      // than merged: two definitions of one clock would drift apart, and the
      // sheet's were already inconsistent about when the clock starts.
      // Which chain of waits this journey runs. A journey names one with its
      // Hold column; with none named, the first is the house default.
      var hold = (window.REF || {}).hold;
      var recipes = (hold || {}).recipes || {};
      // A blank Hold means no hold, not the house default. Cucumbers do not
      // have a test-and-hold clock at all, and generating one for them would
      // be inventing a constraint they do not live under.
      var want = rs[0].hold || '';
      var stages = has(recipes, want) ? recipes[want] : null;
      if (hold && stages && stages.length > 1) {
        var hb = String(hold.branch || '2');
        tasks = tasks.filter(function (t) { return t.branch !== hb; });
        // The leg the clock hangs off: the last one by that name, since a
        // journey packs twice and the hold waits for the whole lot. The first
        // name a journey actually has wins, so a journey that starts at the
        // paperwork rather than the packhouse still gets its clock.
        var seed = null;
        [].concat(hold.starts_after || []).forEach(function (n) {
          if (seed) return;
          tasks.forEach(function (t) { if (t.name === n) seed = t; });
        });
        if (seed) {
          if (branches.indexOf(hb) < 0) branches.push(hb);
          // One leg per stage, on its own lane, for the length of that stage --
          // the same shape as a step in the sheet. The last stage is where it
          // ends and takes no time, but it still gets a leg, because a lane
          // with nothing on it is a lane that does not appear.
          var run = seed.e;
          stages.forEach(function (st, n) {
            var len = +st.hours || 0, pl = st.place || 'Hold';
            var ic = String(st.icon || '').toLowerCase();
            tasks.push({ id: 'h' + n, name: pl, branch: hb,
              place: pl, at: pl, atFrom: pl, s: run, e: run + len,
              icon: ICONS.indexOf(ic) < 0 ? iconFor(pl) : ic,
              note: st.note || '' });
            run += len;
          });
        }
      }

      // Within a branch the rows are already in order, and that is the whole
      // dependency story -- nothing needs an "after" column to say what the
      // sheet already says.
      // Times are written as weekdays, so they only say where in a week a step
      // falls. A journey that runs longer than a week then folds back on
      // itself -- Kauai cut on a Wednesday delivers the following Wednesday,
      // and landed on its own cutting day. A step never starts before the one
      // before it did, so the week is added back until it does not.
      var floor = {};
      tasks.forEach(function (t) {
        var b = t.branch;
        if (has(floor, b)) {
          while (t.s < floor[b]) { t.s += 168; t.e += 168; }
        }
        floor[b] = t.s;
      });

      var last = {};
      tasks.forEach(function (t) {
        t.after = has(last, t.branch) ? [last[t.branch]] : [];
        // A step happens ON its own row, for as long as it takes. Drawing it
        // as a descent from the previous row spent its whole duration moving
        // between two lanes, so an eight-hour pack looked like a transition
        // rather than eight hours of packing. The descent is the link.
        t.from = t.place;
        last[t.branch] = t.id;
      });
      var wins = {};
      tasks.forEach(function (t) {
        [t.atFrom, t.at].forEach(function (pl) {
          if (has(hours, pl)) {
            wins[pl] = { days: hours[pl].days, open: hours[pl].open, close: hours[pl].close };
          }
        });
      });
      // The journey a leg belongs to, which is what it is coloured by. The
      // start day is not part of it: the same journey run on Sunday and on
      // Wednesday is one thing happening twice, and reads better as one.
      tasks.forEach(function (t) { t.def = jn; });
      return { id: slug(jn) + '-' + slug(DOW[anchor]), name: jn, start: DOW[anchor],
        crop: rs[0].crop || '', fob: rs[0].fob || '', transport: rs[0].transport || '',
        hold: rs[0].hold || '',
        branches: branches, tasks: tasks, windows: wins };
    });
  }

  // A step draws on the row it names, or on its own name when it names none.
  // Two steps that share a row share a line of the chart and keep everything
  // else -- their names, their cells in the sheet, their own bars.
  function rowOf(step) {
    var order = (((window.REF || {}).steps || {}).order) || [], k = String(step).toLowerCase();
    for (var i = 0; i < order.length; i++) {
      if (String(order[i].step).toLowerCase() === k) return order[i].row || order[i].step;
    }
    return step;
  }

  // Five hues for however many journeys there are, handed out in the order the
  // sheet lists them, so a journey's colour is a fact about the journey. Every
  // run of it shares the hue and differs only by shade -- the earlier cut takes
  // the stronger one -- which is what says Sunday and Wednesday are one journey
  // gone twice.
  function hueOf(def) {
    var seen = {}, n = 0, i;
    for (i = 0; i < F.length; i++) {
      if (!has(seen, F[i].name)) seen[F[i].name] = n++;
    }
    return (has(seen, def) ? seen[def] : 0) % 5;
  }

  var F = [], DATA = window.DATA || {};
  // sel stays null until something fills it, so a first visit can be told
  // apart from a visit where every toggle was cleared.
  var S = { sel: null, tab: 'flow' };
  // Where the drawn schedule came from, so the line above the chart can say.
  var SRC = { live: false, at: null, why: '' };
  try {
    var sv = JSON.parse(window.localStorage.getItem(STORE) || 'null');
    if (sv) {
      if (sv.sel) S.sel = sv.sel;
      if (sv.tab) S.tab = sv.tab;
      if (sv.rates) S.rates = sv.rates;
    }
  } catch (e) { /* nothing stored, or junk in the slot */ }
  S.rates = S.rates || {};
  function save() {
    try { window.localStorage.setItem(STORE, JSON.stringify(S)); } catch (e) {}
  }
  function cur() {
    var list = shown();
    return list.length === 1 ? list[0] : null;
  }

  // ── Clock ─────────────────────────────────────────────────────────────────
  var SPAN = 3, ANCHOR = 'Sun';
  var dowIdx = function (n) { return DOW.indexOf(n); };
  // Always HH:MM, twenty-four hour. The sheet, reference.json and the chart's
  // own axis all say 18:00; a task list that said 6 PM beside them made the
  // reader convert, and a column of 10 AM / 6:30 PM / 12:30 AM does not line up
  // under itself the way four digits do.
  function clock(h) {
    return hhmm(Math.round(h * 4) / 4);
  }
  function dayOf(h) { return Math.floor(h / 24); }
  function dayName(d) { return DOW[((dowIdx(ANCHOR) + d) % 7 + 7) % 7]; }
  function stamp(h) { return dayName(dayOf(h)) + ' ' + clock(h); }
  function hhmm(h) {
    var t = ((h % 24) + 24) % 24, hr = Math.floor(t), mn = Math.round((t - hr) * 60);
    return (hr < 10 ? '0' : '') + hr + ':' + (mn < 10 ? '0' : '') + mn;
  }
  function fromHM(s) {
    var p = String(s || '').split(':'), h = parseFloat(p[0]), m = parseFloat(p[1] || 0);
    return isNaN(h) ? 0 : Math.max(0, Math.min(23.99, h + (isNaN(m) ? 0 : m / 60)));
  }
  function num(v, d) { var n = parseFloat(v); return isNaN(n) ? (d || 0) : n; }
  // Always x.x h. A column that switched to minutes under the hour could not be
  // compared down its own length -- 30 m sorted and read as larger than 4 h.
  function dur(h) {
    var v = h > 0 ? h : 0;
    return v.toFixed(1) + ' h';
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function all(q) { return [].slice.call(document.querySelectorAll(q)); }
  function uid(p) { return p + Math.random().toString(36).slice(2, 7); }
  function cssId(id) { return String(id).replace(/[^A-Za-z0-9_-]/g, '\\$&'); }

  // ── Reading a flow ────────────────────────────────────────────────────────
  // There is nothing to solve: the times are already there. This only sorts,
  // works out the places, and finds the links worth drawing.
  function read(flow) {
    var byId = {};
    flow.tasks.forEach(function (t) { byId[t.id] = t; });
    var pts = flow.tasks.map(function (t) {
      return { id: t.id, t: t, s: num(t.s), e: num(t.e), place: t.place || 'Somewhere' };
    });
    var start = 0, end = 0;
    pts.forEach(function (p) {
      start = Math.min(start === 0 && !pts.length ? p.s : start, p.s);
      end = Math.max(end, p.e, p.s);
    });
    if (pts.length) start = Math.min.apply(null, pts.map(function (p) { return p.s; }));
    var idle = pts.reduce(function (a, p) { return a + Math.max(0, p.e - p.s); }, 0);
    var moving = 0, still = 0;
    pts.forEach(function (p) {
      // The leg carries its own origin, so a bar has a real slope rather than
      // one inferred from whatever happened to come before it.
      p.from = p.t.from || p.place;
      moving += Math.max(0, p.e - p.s);
    });
    var edges = [];
    flow.tasks.forEach(function (t) {
      (t.after || []).forEach(function (id) {
        if (!byId[id]) return;
        edges.push({ from: id, to: t.id, h0: num(byId[id].e), h1: num(t.s),
                     p0: byId[id].place || 'Somewhere', p1: t.place || 'Somewhere' });
      });
    });
    // Waiting is the gap between one step finishing and the next starting.
    // Summing the flat bars used to say it, back when a flat bar meant sitting
    // in one place; a lane per step means every bar is a step being done.
    edges.forEach(function (e) { still += Math.max(0, e.h1 - e.h0); });
    var broken = flow.tasks.filter(function (t) { return num(t.e) < num(t.s); });
    return { byId: byId, pts: pts, edges: edges, broken: broken,
             start: start, end: end, idle: Math.round(idle),
             still: Math.round(still), moving: Math.round(moving),
             days: dayOf(end) - dayOf(start), hrs: Math.round(end - start) };
  }
  // Every location a leg touches, in the order the journey reaches them, so the
  // vertical axis reads top to bottom the way the product travels.
  function places(flow) { return laneScan(flow).order; }
  function laneScan(flow) {
    var seen = {}, out = [];
    function lane(p, b) {
      if (!has(seen, p)) { seen[p] = { b: b, i: out.length }; out.push(p); }
      else if (b < seen[p].b) seen[p].b = b;
    }
    // Every step there is, whether or not this selection uses one. The rows
    // then stay put as journeys are switched on and off, and a blank row says
    // the same thing a blank cell in the sheet says: this one skips it.
    var ref = window.REF || {};
    ((ref.steps || {}).order || []).forEach(function (st) { lane(rowOf(String(st.step)), '1'); });
    var hb = String((ref.hold || {}).branch || '2');
    var recipes = (ref.hold || {}).recipes || {};
    Object.keys(recipes).forEach(function (k) {
      (recipes[k] || []).forEach(function (st) { lane(String(st.place), hb); });
    });
    flow.tasks.forEach(function (t) {
      var b = t.branch || '1';
      [t.from, t.place].forEach(function (p) { lane(p || 'Somewhere', b); });
    });
    // Branch 1 is the pallet and branch 2 is the clock running beside it, so
    // the places only the clock touches go underneath -- the product's own
    // path then reads as one block rather than being interrupted by the lab.
    // The lanes are the steps, and the steps have an order of their own --
    // the one reference.json lists them in, which is the order they happen.
    // Reaching them is not the same thing: the 140 journey reaches Customer
    // third, but Customer is still the last step there is.
    var rank = {}, r = 0;
    SHEET_ORDER.forEach(function (name) {
      var k = String(rowOf(name)).toLowerCase();
      if (!has(rank, k)) rank[k] = r++;
    });
    ((((window.REF || {}).steps || {}).order) || []).forEach(function (st) {
      var k = String(rowOf(String(st.step))).toLowerCase();
      if (!has(rank, k)) rank[k] = r++;
    });
    function rk(p) {
      var k = String(p).toLowerCase();
      return has(rank, k) ? rank[k] : 1e6 + seen[p].i;
    }
    out.sort(function (a, b) {
      if (seen[a].b !== seen[b].b) return seen[a].b < seen[b].b ? -1 : 1;
      return rk(a) - rk(b);
    });
    return { order: out, of: seen };
  }
  function feedsOf(flow, id) {
    return flow.tasks.filter(function (t) { return (t.after || []).indexOf(id) >= 0; });
  }
  function winOf(flow, place) { return (flow.windows || {})[place] || null; }
  function winSpan(w) {
    return clock(num(w.open)) + '–' + clock(num(w.close));
  }

  // ── Drawing ───────────────────────────────────────────────────────────────
  var LANE_H = 38, PAD_T = 14, PAD_B = 18, PLOT_PX = 1040;
  var X = function (h) { return (h / (SPAN * 24)) * 1000; };
  var PCT = function (h) { return (h / (SPAN * 24)) * 100; };

  function chart(flow, r) {
    // A hue per journey and a shade per run of it. Ten threads cross each
    // other in a week; five colours made the Sunday barge and the Wednesday
    // barge the same line. Sharing a hue still says they are the same journey,
    // and the earlier cut takes the stronger shade.
    //
    // The hue comes from hueOf, which counts every journey there is rather than
    // the ones on screen. Counted from the selection it moved: switching one
    // journey off renumbered the rest, so a thread changed colour without
    // changing, and no swatch anywhere else could be trusted to match it.
    var shade = {}, next = {};
    flow.tasks.forEach(function (t) {
      var d = t.def || flow.name, run = t.journey || d;
      if (!has(next, d)) next[d] = 0;
      if (!has(shade, run)) shade[run] = next[d]++;
    });
    function jc(t) {
      var d = t.def || flow.name, run = t.journey || d;
      return ' j' + hueOf(d) + (shade[run] % 2 ? 'b' : 'a');
    }

    // Threads that share a step share a row, and two lines on one row are one
    // line. Each run gets its own hair's breadth of the lane -- fanned about
    // the middle, so nothing is on the row and everything is near it. The fan
    // narrows as more threads are shown, because the lane does not grow.
    var slot = {}, slots = 0;
    flow.tasks.forEach(function (t) {
      var run = t.journey || t.def || flow.name;
      if (!has(slot, run)) slot[run] = slots++;
    });
    var SPREAD = Math.min(3.5, 16 / Math.max(1, slots - 1));
    function dy(t) {
      var run = t.journey || t.def || flow.name;
      return (slot[run] - (slots - 1) / 2) * SPREAD;
    }
    function at(place, t) {
      var y = yOf[place];
      return (y === undefined ? 0 : y) + dy(t);
    }

    var scan = laneScan(flow), lanes = scan.order, yOf = {};
    lanes.forEach(function (l, i) { yOf[l] = PAD_T + i * LANE_H + LANE_H / 2; });
    var H = PAD_T + lanes.length * LANE_H + PAD_B;
    // Where the pallet's world ends and the clock's begins. The lanes are
    // already grouped by branch, so the line goes wherever that group changes.
    var splits = [];
    for (var n = 1; n < lanes.length; n++) {
      if (scan.of[lanes[n]].b !== scan.of[lanes[n - 1]].b) splits.push(PAD_T + n * LANE_H);
    }

    var svg = '';
    // Every two hours, faint. With no times written in the grid this is how a
    // bar is read, so it is the finest ruling that stays quiet. The day
    // boundaries keep their own heavier line.
    for (var q = 2; q < SPAN * 24; q += 2) {
      if (q % 24 === 0) continue;
      svg += '<line class="hr" x1="' + X(q) + '" x2="' + X(q) + '" y1="0" y2="' + H + '"/>';
    }
    for (var c = 1; c < SPAN; c++) {
      svg += '<line class="col" x1="' + X(c * 24) + '" x2="' + X(c * 24) + '" y1="0" y2="' + H + '"/>';
    }
    lanes.forEach(function (l, i) {
      var y = PAD_T + i * LANE_H;
      svg += '<line class="lane" x1="0" x2="1000" y1="' + (y + LANE_H / 2) + '" y2="' + (y + LANE_H / 2) + '"/>';
    });
    // Everything below the first split is the clock rather than the pallet.
    // A tint says that better than a rule does: it names the region instead of
    // just marking where one ends.
    if (splits.length) {
      svg = '<rect class="aside" x="0" y="' + splits[0] + '" width="1000" height="' +
        (H - splits[0]) + '"/>' + svg;
    }

    // Links first, so a bar always sits on top of the thread that reached it.
    // A link runs from where one step finished to where the next begins, which
    // is now a descent as well as a wait -- the steps themselves stay on their
    // own rows. A link that runs backwards means a task starts before what it
    // comes after has finished, which is allowed and is worth seeing.
    var link = '';
    r.edges.forEach(function (e) {
      var t0 = r.byId[e.to] || r.byId[e.from];
      var a = at(e.p0, t0), b = yOf[e.p1] === undefined ? a : at(e.p1, t0);
      if (Math.abs(e.h1 - e.h0) <= .01 && a === b) return;
      // In the thread's own colour: it is part of the thread, and the descent
      // between two steps is where a busy week is hardest to follow.
      link += '<line class="link' + (t0 ? jc(t0) : '') + (e.h1 < e.h0 ? ' back' : '') +
        '" x1="' + X(e.h0) + '" y1="' + a + '" x2="' + X(e.h1) + '" y2="' + b + '"/>';
    });

    var move = '', wait = '';
    r.pts.forEach(function (p) {
      var y1 = at(p.from === undefined ? p.place : p.from, p.t), y2 = at(p.place, p.t);
      var seg = 'x1="' + X(p.s) + '" y1="' + y1 + '" x2="' + X(p.e) + '" y2="' + y2 + '"';
      // Every leg is a step being done, so every leg is drawn solid. What is
      // dotted is the link between them, which is the waiting. A lane per step
      // means the old test -- did it change place? -- now only ever catches
      // the first leg of a branch, and packing is not idleness.
      var still = false;
      // Branches are separate threads until they meet, so they do not share a
      // colour.
      var b = jc(p.t);
      if (p.e - p.s > .01 || !still) {
        if (still) wait += '<line class="wait' + b + '" ' + seg + '/>';
        else move += '<line class="move' + b + '" ' + seg + '/>';
      }
      // A dot is three pixels across, which is not something to aim at, so each
      // carries an invisible one behind it to be hovered. What it says is the
      // whole of what that dot is: which thread, which step, and the moment.
      var who = threadName(p.t.def || flow.name);
      function dot(x, y, when, h) {
        return '<circle class="pt' + b + '" cx="' + x + '" cy="' + y + '" r="3"/>' +
          '<circle class="hit" cx="' + x + '" cy="' + y + '" r="9"><title>' +
          esc(who) + ' \u00b7 ' + esc(p.t.name) + ' ' + when + ' ' + stamp(h) +
          '</title></circle>';
      }
      svg += dot(X(p.s), y1, 'starts', p.s) + dot(X(p.e), y2, 'stops', p.e);
    });
    svg += link + wait + move;

    // No names along the threads. Each was the journey's own name, printed
    // once where the thread had room for it -- useful when a line's only
    // identity was its shade. The journey chips are colour-fast now and carry
    // the same hue, so the chart can be read against the bar above it and the
    // names were repeating what the colour already said. threadName stays: it
    // is still what a dot's tooltip leads with.

    var lbl = lanes.map(function (l) {
      return '<div class="lane-lbl" style="height:' + LANE_H + 'px">' + esc(l) + '</div>';
    }).join('');

    return '<div class="chart"><div class="gut" style="padding-top:' + PAD_T + 'px">' + lbl + '</div>' +
      '<div class="plot" style="height:' + H + 'px">' +
      '<svg class="svg" viewBox="0 0 1000 ' + H + '" preserveAspectRatio="none">' + svg + '</svg>' +
      '</div></div>';
  }


  // ── Gating on the hours ───────────────────────────────────────────────────
  // The times come from the Markdown, so a window cannot push them about. What
  // it can do is say when a written time falls outside the door it belongs to.
  function nextOpen(w, h) {
    for (var i = 0; i < 28; i++) {
      var d = Math.floor(h / 24) + i, dw = (dowIdx(ANCHOR) + d) % 7;
      if (!w.days[dw]) continue;
      var o = d * 24 + num(w.open), c = d * 24 + num(w.close);
      if (h <= o) return o;
      if (h < c) return h;
    }
    return h;
  }
  function outside(flow, place, h) {
    var w = winOf(flow, place);
    return w ? nextOpen(w, h) !== h : false;
  }
  function offences(flow) {
    var out = [];
    flow.tasks.forEach(function (t) {
      var pl = t.at || t.place || 'Somewhere';
      if (!winOf(flow, pl)) return;
      if (outside(flow, pl, num(t.s))) out.push({ t: t, f: 'starts', h: num(t.s), pl: pl });
      if (outside(flow, pl, num(t.e))) out.push({ t: t, f: 'stops', h: num(t.e), pl: pl });
    });
    return out;
  }

  // ── The task list, which is a reading of the Markdown ─────────────────────
  // No After column. It listed what a task came after -- its predecessor --
  // under a heading that reads as what comes next, so it was routinely taken
  // backwards. The order it described is already the order of the rows, and
  // the chart draws the same dependency as a link. The data behind it is
  // untouched: t.after still feeds the links and the scheduling.
  var COLS = ['', '', 'Task', 'Place', 'Starts', 'Stops', 'Takes', 'Note'];
  function taskTable(flow, r) {
    var head = '';
    var body = flow.tasks.map(function (t, i) {
      // With several journeys in one list, a row has to say which it is from.
      // A line between them says it once instead of once per row.
      var mark = '';
      if (t.journey && t.journey !== head) {
        head = t.journey;
        mark = '<div class="grp">' + esc(head) + '</div>';
      }
      var p = null;
      r.pts.forEach(function (x) { if (x.id === t.id) p = x; });
      var len = num(t.e) - num(t.s);
      var still = false;   // see the chart: a leg is a step, not a place change
      var where = t.at || t.place || 'Somewhere';
      var badS = outside(flow, where, num(t.s));
      var badE = outside(flow, where, num(t.e));
      return mark + '<div class="row' + (len < 0 ? ' bad' : '') + '" id="task-' + esc(t.id) + '">' +
        '<div class="cell n">' + (i + 1) + '</div>' +
        '<div class="cell ico">' + ico(t.icon) + '</div>' +
        '<div class="cell nm">' + esc(t.name) + '</div>' +
        '<div class="cell plc">' + esc(t.at || t.place) + '</div>' +
        '<div class="cell tm' + (badS ? ' out' : '') + '"' +
        (badS ? ' title="' + esc(where) + ' is shut then."' : '') + '>' + stamp(num(t.s)) + '</div>' +
        '<div class="cell tm' + (badE ? ' out' : '') + '"' +
        (badE ? ' title="' + esc(where) + ' is shut then."' : '') + '>' + stamp(num(t.e)) + '</div>' +
        '<div class="cell dur' + (len < 0 ? ' bad' : still && len > .01 ? ' still' : '') + '">' +
        (len < 0 ? 'backwards' : dur(len)) + '</div>' +
        '<div class="cell nt">' + esc(t.note || '') + '</div>' +
        '</div>';
    }).join('');
    return '<div class="grid">' +
      COLS.map(function (c, i) { return '<div class="gh' + (i === 6 ? ' r' : '') + '">' + c + '</div>'; }).join('') +
      body + '</div>';
  }

  // ── What has to be packed, and how long it takes ──────────────────────────
  // Three case types at three different rates against two destinations, which
  // is the shape the pack line is actually planned in. Cases only: the pack
  // line counts cases, and pounds were a second number nobody was using here.
  var GROUPS = (window.DATA && DATA.pack_groups) || [['LW', 'LW'], ['LF', 'LF'], ['TRAY', 'LR/AR/WR']];
  var DESTS = [['on', 'On-island'], ['off', 'Off-island']];
  // Minutes per case, not cases per minute: a tray takes six minutes, it does
  // not come off the line six at a time.
  var RATE_DEF = { LW: 2, LF: 1, TRAY: 1 };

  function startHour() {
    var v = parseInt(S.startHour, 10);
    return isNaN(v) || v < 0 || v > 23 ? 10 : v;
  }
  function hourLabel(h) {
    var x = ((Math.floor(h) % 24) + 24) % 24;
    return x === 0 ? '12a' : x < 12 ? x + 'a' : x === 12 ? '12p' : (x - 12) + 'p';
  }
  function rates() {
    var r = {};
    GROUPS.forEach(function (g) {
      var v = S.rates && S.rates[g[0]];
      r[g[0]] = (v === undefined || v === null || v === '' || +v <= 0) ? RATE_DEF[g[0]] : +v;
    });
    return r;
  }
  function mins(cases, rate) { return cases * rate; }
  function showMins(m) {
    if (!m) return '—';
    if (m < 60) return Math.round(m) + ' min';
    var h = Math.floor(m / 60), mm = Math.round(m - h * 60);
    return h + ' h' + (mm ? ' ' + mm : '');
  }

  function ordersView() {
    var P = (window.DATA && DATA.packs) || [];
    if (!P.length) return '<p class="hint">No pack data in data.json.</p>';
    var R = rates();
    var tot = {}, n = 0;
    DESTS.forEach(function (d) { GROUPS.forEach(function (g) { tot[d[0] + g[0]] = 0; }); });
    P.forEach(function (row) {
      n++;
      DESTS.forEach(function (d) {
        GROUPS.forEach(function (g) { tot[d[0] + g[0]] += (row[d[0]] || {})[g[0]] || 0; });
      });
    });

    // ── The two pack days ────────────────────────────────────────────────
    // Day 1 is a 6.5 hour shift filled in a fixed order: all of Kona's LW,
    // then as much off-island LW as still fits, then all the LF and all the
    // trays for both days. Day 2 is the off-island LW that did not fit.
    var DAY1 = 6.5;
    var LB = { LW: 10.5, LF: 10, TRAY: 2.25 };
    var konaLW = n ? tot.onLW / n : 0;
    var offLW = n ? tot.offLW / n : 0;
    var lf = n ? (tot.onLF + tot.offLF) / n : 0;
    var tray = n ? (tot.onTRAY + tot.offTRAY) / n : 0;
    var hKona = mins(konaLW, R.LW) / 60, hLF = mins(lf, R.LF) / 60, hR = mins(tray, R.TRAY) / 60;
    var room = DAY1 - (hKona + hLF + hR);
    var offLW1 = R.LW > 0 ? Math.max(0, Math.min(offLW, room * 60 / R.LW)) : 0;
    var offLW2 = offLW - offLW1;
    var segs1 = [
      ['Kona LW', konaLW, hKona, konaLW * LB.LW, 'k'],
      ['Off-island LW', offLW1, mins(offLW1, R.LW) / 60, offLW1 * LB.LW, 'o'],
      ['LF', lf, hLF, lf * LB.LF, 'f'],
      ['LR/AR/WR', tray, hR, tray * LB.TRAY, 'r']
    ].filter(function (x) { return x[1] > 0.5; });
    var segs2 = [['Off-island LW', offLW2, mins(offLW2, R.LW) / 60, offLW2 * LB.LW, 'o']]
      .filter(function (x) { return x[1] > 0.5; });
    var wide = Math.max(hKona + hLF + hR + mins(offLW1, R.LW) / 60,
                        mins(offLW2, R.LW) / 60, DAY1) || 1;
    function dayRow(label, segs, over) {
      var h = segs.reduce(function (a, x) { return a + x[2]; }, 0);
      var lb = segs.reduce(function (a, x) { return a + x[3]; }, 0);
      return '<div class="pd"><span class="pd-l">' + label + '</span>' +
        '<span class="pd-bar">' +
        segs.map(function (x) {
          return '<span class="pd-s ' + x[4] + '" style="width:' + (x[2] / wide * 100).toFixed(2) +
            '%" title="' + esc(x[0]) + ' — ' + Math.round(x[1]).toLocaleString() + ' cs, ' +
            showMins(x[2] * 60) + ', ' + Math.round(x[3]).toLocaleString() + ' lb">' +
            (x[2] / wide > .07 ? esc(x[0]) : '') + '</span>';
        }).join('') +
        '</span>' +
        '<span class="pd-h' + (over ? ' over' : '') + '">' + showMins(h * 60) + '</span>' +
        '<span class="pd-lb">' + Math.round(lb).toLocaleString() + ' lb</span></div>';
    }
    var st = startHour(), scale = '';
    for (var hh = 0; hh <= Math.floor(wide); hh++) {
      scale += '<span class="pd-t" style="left:' + (hh / wide * 100).toFixed(3) + '%">' +
        hourLabel(st + hh) + '</span>';
    }
    var packBar = '<div class="packdays">' +
      '<div class="pd pd-axis"><span class="pd-l"></span>' +
      '<span class="pd-bar pd-scale">' + scale + '</span>' +
      '<span class="pd-h"></span><span class="pd-lb"></span></div>' +
      dayRow('Pack day 1', segs1, hKona + hLF + hR > DAY1 + .01) +
      dayRow('Pack day 2', segs2, false) + '</div>';

    var rateRow = '<div class="rates"><span class="lbl">Minutes per case</span>' +
      GROUPS.map(function (g) {
        return '<label class="rate">' + esc(g[1]) +
          '<input type="text" inputmode="numeric" value="' + R[g[0]] +
          '" data-rate="' + g[0] + '"></label>';
      }).join('') +
      '<label class="rate"><span class="lbl">Starts</span>' +
      '<input type="text" inputmode="numeric" value="' + st + '" data-start="1"></label></div>';

    var body = P.map(function (row, i) {
      var first = i % 2 === 0;
      return '<tr class="' + (first ? 'wkstart' : '') + '">' +
        (first ? '<th rowspan="2" class="wk">' + shortDate(row.wk) + '</th>' : '') +
        '<th class="hf">' + (row.half === 'early' ? 'Sun / Mon' : 'Wed / Thu') + '</th>' +
        DESTS.map(function (d) {
          return GROUPS.map(function (g) {
            var v = (row[d[0]] || {})[g[0]] || 0;
            return '<td class="fig">' + (v ? v.toLocaleString() : '&mdash;') + '</td>';
          }).join('');
        }).join('') + '</tr>';
    }).join('');

    var minRow = '<tr class="minrow"><th></th><th class="hf">Minutes</th>' +
      DESTS.map(function (d) {
        return GROUPS.map(function (g) {
          return '<td class="fig">' + showMins(mins(n ? tot[d[0] + g[0]] / n : 0, R[g[0]])) + '</td>';
        }).join('');
      }).join('') + '</tr>';

    var avg = '<tr class="grp"><th colspan="8">Per window</th></tr>' +
      '<tr><th></th><th class="hf">Average</th>' +
      DESTS.map(function (d) {
        return GROUPS.map(function (g) {
          return '<td class="fig">' + Math.round(n ? tot[d[0] + g[0]] / n : 0).toLocaleString() + '</td>';
        }).join('');
      }).join('') + '</tr>';

    return packBar + rateRow +
      '<table class="otbl orders"><thead>' +
      '<tr><th></th><th></th>' +
      DESTS.map(function (d) { return '<th colspan="3" class="grp2">' + d[1] + '</th>'; }).join('') +
      '</tr><tr class="units"><th></th><th></th>' +
      DESTS.map(function () {
        return GROUPS.map(function (g) { return '<th>' + esc(g[1]) + '</th>'; }).join('');
      }).join('') + '</tr></thead><tbody>' + minRow + body + avg + '</tbody></table>';
  }

  function shortDate(iso) {
    var M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var d = new Date(iso + 'T00:00:00');
    return d.getDate() + ' ' + M[d.getMonth()];
  }

  // ── Hours: everybody's clock, not just this journey's ─────────────────────
  // A window belongs to a party, not to a task, and the ones that matter are
  // the ones this product waits at whether or not the journey on screen goes
  // through them.
  function hoursView() {
    var R = window.REF || { hours: [], sites: [], sailings: [] };
    var out = '';
    if (R.hours.length) {
      out += '<h4>Who will take it, and when</h4>' +
        '<table class="otbl hrs"><thead><tr><th>Place</th><th>Days</th><th>Opens</th>' +
        '<th>Closes</th><th>Note</th></tr></thead><tbody>' +
        R.hours.map(function (w) {
          return '<tr><th class="hf">' + esc(w.place) + '</th>' +
            '<td class="dcell">' + dayCells(w.days) + '</td>' +
            '<td class="mono">' + clock(num(w.open)) + '</td>' +
            '<td class="mono">' + clock(num(w.close)) + '</td>' +
            '<td class="nt">' + esc(w.note || '') + '</td></tr>';
        }).join('') + '</tbody></table>';
    }
    // Our own places are deliberately not listed here. They have no days and no
    // window -- a leg between two of them is bounded by the schedule and nothing
    // else -- and a table of blanks under a page about opening hours only
    // invited the question of what the blanks meant. They stay in
    // reference.json as the record of which places are ours.
    if (R.sailings.length) {
      out += '<h4>Young Brothers sailings</h4>' +
        '<table class="otbl hrs"><thead><tr><th>Route</th><th>Departs</th><th>Arrives</th>' +
        '<th>Connects</th><th>Note</th></tr></thead><tbody>' +
        R.sailings.map(function (x) {
          var open = /\?/.test(x.departs) || /\?/.test(x.arrives);
          return '<tr' + (open ? ' class="unk"' : '') + '><th class="hf">' + esc(x.route) + '</th>' +
            '<td class="mono">' + esc(x.departs) + '</td>' +
            '<td class="mono">' + esc(x.arrives) + '</td>' +
            '<td class="nt">' + esc(x.connects || '') + '</td>' +
            '<td class="nt">' + mark(x.note || '') + '</td></tr>';
        }).join('') + '</tbody></table>';
    }
    // What this journey actually uses, which is a subset and worth seeing
    // apart -- and only means anything while one journey is on screen.
    var flow = cur();
    var pl = flow ? uniq(flow.tasks.reduce(function (a, t) {
      return a.concat([t.atFrom, t.at]);
    }, [])).filter(function (p) { return winOf(flow, p); }) : [];
    if (pl.length) {
      out += '<h4>Used by ' + esc(flow.name) + '</h4>' +
        '<table class="otbl hrs"><thead><tr><th>Place</th><th>Days</th><th>Opens</th>' +
        '<th>Closes</th><th></th></tr></thead><tbody>' +
        pl.map(function (p) {
          var w = winOf(flow, p);
          return '<tr><th class="hf">' + esc(p) + '</th>' +
            '<td class="dcell">' + dayCells(w.days) + '</td>' +
            '<td class="mono">' + clock(num(w.open)) + '</td>' +
            '<td class="mono">' + clock(num(w.close)) + '</td><td></td></tr>';
        }).join('') + '</tbody></table>';
    }
    return out + '<p class="hint">All of this is set in <code>reference.json</code> — ' +
      'gates under <code>hours</code>, ours under <code>sites</code>, boats under ' +
      '<code>sailings</code>. Only a gate has a window, so only a gate can make a leg ' +
      'late. Days here are real weekdays, the same as in <code>legs.csv</code>.</p>';
  }
  function dayCells(days) {
    return DOW.map(function (dn, d) {
      return '<span class="d' + (days[d] ? ' on' : '') + '" title="' + dn + '">' + dn[0] + '</span>';
    }).join('');
  }
  function mark(t) {
    return esc(t).replace(/NOT CONFIRMED/g, '<b class="unconfirmed">Not confirmed</b>');
  }

  // ── Render ────────────────────────────────────────────────────────────────
  var TABS = [['flow', 'Map'], ['orders', 'Orders'], ['hours', 'Hours']];
  function paint() {
    seg('tabs', TABS, S.tab, function (v) { S.tab = v; save(); paint(); });
    TABS.forEach(function (t) {
      document.getElementById('page-' + t[0]).hidden = t[0] !== S.tab;
    });
    if (S.tab === 'flow') paintFlow();
    if (S.tab === 'orders') paintOrders();
    if (S.tab === 'hours') document.getElementById('hours').innerHTML = hoursView();
  }

  function paintFlow() {
    if (!F.length) {
      document.getElementById('grid').innerHTML = '<p class="hint">No journeys.</p>';
      document.getElementById('src').innerHTML = srcLine();
      return;
    }
    var list = shown();
    picker();
    document.getElementById('src').innerHTML = srcLine();
    if (!list.length) {
      document.getElementById('grid').innerHTML =
        '<p class="hint">Nothing is both of those.</p>';
      document.getElementById('axis').innerHTML = '';
      document.getElementById('tasks').innerHTML = '';
      return;
    }
    var flow = merge(list);
    // One journey is drawn from its own cut; several share the week, because
    // that is the only axis they have in common.
    ANCHOR = flow.many ? 'Sun' : (flow.start || 'Sun');

    var r = read(flow);
    // As many days as the drawing reaches into, and not one more.
    SPAN = Math.max(2, Math.ceil(r.end / 24));

    // Mark the days we actually cut on -- which is where each shown journey
    // begins, by position rather than by name. A journey that runs past the
    // end of the week reaches a second Sunday, and that Sunday is not this
    // journey's cut.
    var cuts = {};
    list.forEach(function (f) {
      cuts[((dowIdx(f.start) - dowIdx(ANCHOR)) % 7 + 7) % 7] = 1;
    });
    var ax = '';
    for (var i = 0; i < SPAN; i++) {
      ax += '<div class="day' + (cuts[i] ? ' cut' : '') + '">' + dayName(i) + '</div>';
    }
    // The four-hour marks are only useful if you can say what hour they are.
    var hx = '';
    for (var q = 0; q < SPAN * 24; q += 4) {
      var hh = q % 24;
      hx += '<span class="hlab' + (hh === 0 ? ' mid' : '') + '" style="left:' + PCT(q) + '%">' +
        (hh === 0 ? '12a' : hh < 12 ? hh + 'a' : hh === 12 ? '12p' : (hh - 12) + 'p') + '</span>';
    }
    document.getElementById('axis').innerHTML =
      '<div class="axrow"><div class="gut"></div><div class="days">' + ax + '</div></div>' +
      '<div class="axrow"><div class="gut"></div><div class="hours-axis">' + hx + '</div></div>';
    document.getElementById('grid').innerHTML = chart(flow, r);

    var off = offences(flow), warn = '';
    if (r.broken.length) {
      warn += '<div class="warn">' + r.broken.map(function (t) { return esc(t.name); }).join(', ') +
        ' stop' + (r.broken.length > 1 ? '' : 's') + ' before ' +
        (r.broken.length > 1 ? 'they' : 'it') + ' start' + (r.broken.length > 1 ? '' : 's') + '.</div>';
    }
    if (off.length) {
      warn += '<div class="warn">' + off.length + ' time' + (off.length > 1 ? 's fall' : ' falls') +
        ' outside the opening hours of the place ' + (off.length > 1 ? 'they belong' : 'it belongs') +
        ' to: ' + off.map(function (o) {
          return esc(o.t.name) + ' ' + o.f + ' ' + stamp(o.h) + ', but ' + esc(o.pl) + ' is open ' +
                 winSpan(winOf(flow, o.pl));
        }).join('; ') + '.</div>';
    }
    document.getElementById('warn').innerHTML = warn;
    document.getElementById('tnote').textContent =
      flow.tasks.length + ' legs · ' + (flow.branches || []).length + ' branches · ' +
      places(flow).length + ' places · ' + dur(r.hrs) + ' end to end, ' +
      dur(r.still) + ' waiting';
    document.getElementById('tasks').innerHTML = taskTable(flow, r);

    // A bar or a dot finds its row, which is the only interaction left.
    all('#grid [data-task]').forEach(function (el) {
      el.addEventListener('click', function () {
        var c = document.getElementById('task-' + el.getAttribute('data-task'));
        if (!c) return;
        c.classList.add('lit');
        c.scrollIntoView({ block: 'center' });
        window.setTimeout(function () { c.classList.remove('lit'); }, 2600);
      });
    });
  }

  function paintOrders() {
    var host = document.getElementById('orders');
    host.innerHTML = ordersView();
    // Delegated, and bound once. A rate change repaints the whole view, so a
    // handler holding its own input goes on reading the element it replaced.
    if (!host.__wired) {
      host.__wired = true;
      host.addEventListener('input', function (ev) {
        var inp = ev.target;
        if (!inp || !inp.getAttribute) return;
        var key = inp.getAttribute('data-rate'), pos = inp.selectionStart;
        if (inp.getAttribute('data-start')) {
          var h = parseInt(inp.value, 10);
          S.startHour = isNaN(h) || h < 0 || h > 23 ? '' : h;
        } else if (key) {
          var v = parseFloat(inp.value);
          S.rates = S.rates || {};
          S.rates[key] = isNaN(v) || v <= 0 ? '' : v;
        } else { return; }
        save();
        host.innerHTML = ordersView();
        var again = host.querySelector(key ? '[data-rate="' + key + '"]' : '[data-start]');
        if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (e) {} }
      });
    }
  }

  // ── Picking a journey ─────────────────────────────────────────────────────
  // Eight variants in one row was a list to read rather than a choice to make.
  // The same eight are three questions: which cut, where it is going, and what
  // carries it. A question with only one answer is not a question and is not
  // drawn, which is what keeps the freight toggle off the on-island journeys.
  // Where it goes, how it gets there and which hold it runs are three columns
  // in the sheet, but they are one question to ask: which journey. Offering
  // them as three toggles would offer combinations that do not exist -- 140 by
  // barge, off-island on the long hold -- so they are folded into one.
  function facets(f) {
    return { when: f.start, jrn: jrnKey(f) };
  }
  // The key rides in a DOM attribute when it becomes a button, so it has to
  // survive being written out and read back. A NUL does not.
  function jrnKey(f) {
    return [f.crop || '', f.fob || '', f.transport || '', f.hold || ''].join('|');
  }

  // Journeys that are in the sheet but that we do not want offered. Named by
  // the columns that tell them apart -- the lettuce 140 that waits forty-eight
  // hours, and the lettuce that flies to Oahu -- so a journey stays hidden
  // through an edit to a column it is not named by.
  //
  // Hidden here rather than cut from legs.csv: the page reads the sheet itself
  // on every load and the snapshot is only the fallback, so deleting a column
  // would hide them until the next refresh and no longer.
  var HIDDEN = [
    { crop: 'lettuce', fob: '140', hold: '48h' },
    { crop: 'lettuce', fob: 'oahu', transport: 'air' }
  ];
  function isHidden(f) {
    for (var i = 0; i < HIDDEN.length; i++) {
      var want = HIDDEN[i], all = true, k;
      for (k in want) {
        if (!Object.prototype.hasOwnProperty.call(want, k)) continue;
        if (String(f[k] || '').trim().toLowerCase() !== want[k]) { all = false; break; }
      }
      if (all) return true;
    }
    return false;
  }

  // A journey is named by its customer, plus whatever actually varies between
  // the journeys that share that customer. 140 always goes on our truck and
  // differs only by hold; off-island always holds fast and differs only by
  // mode; pickup differs from nothing and needs no bracket at all.
  function jrnLabel(f) {
    var kin = F.filter(function (g) {
      return (g.crop || '') === (f.crop || '') && (g.fob || '') === (f.fob || '');
    });
    var bits = [];
    ['transport', 'hold'].forEach(function (k) {
      if (!f[k]) return;
      if (uniq(kin.map(function (g) { return g[k] || ''; })).length > 1) bits.push(f[k]);
    });
    return (f.fob || 'Journey') + (bits.length ? ' (' + bits.join(', ') + ')' : '');
  }

  // We cut on the anchor day and the day after, and both feed the same
  // departure, so the pair is the honest label for the choice.
  //
  // The pair named is the two days the journeys START, which is the day after
  // the anchor and the one after that -- Sun anchors Mon/Tue, Wed anchors
  // Thu/Fri. A label only: `start` stays the anchor day everywhere it is used,
  // which is what the chart is drawn from and what the sheet's Start Day counts
  // from. Change this and you change what the chips read, nothing else.
  function cutLabel(day) {
    var i = DOW.indexOf(day);
    return i < 0 ? day : DOW[(i + 1) % 7] + '/' + DOW[(i + 2) % 7];
  }

  function uniq(list) {
    var seen = {}, out = [];
    list.forEach(function (v) {
      if (v !== '' && !Object.prototype.hasOwnProperty.call(seen, v)) { seen[v] = 1; out.push(v); }
    });
    return out;
  }

  // Answer as much of the wanted combination as exists, giving up the freight
  // before the destination and the cut before either.
  var KEYS = ['jrn', 'when'];

  // Each question holds a set of answers rather than one. An empty set asks
  // nothing, so turning every answer off is how you say "the whole week".
  function shown() {
    var sel = S.sel || {};
    return F.filter(function (f) {
      var x = facets(f);
      for (var i = 0; i < KEYS.length; i++) {
        var list = sel[KEYS[i]] || [];
        if (list.length && list.indexOf(x[KEYS[i]]) < 0) return false;
      }
      return true;
    });
  }

  // Several journeys are drawn as one picture: the same lanes, and one week
  // rather than each journey's own first day. A leg keeps the weekday it was
  // written on, so this is a re-hanging, not a recalculation.
  function merge(list) {
    if (list.length === 1) return list[0];
    var tasks = [], branches = [], windows = {};
    list.forEach(function (f, i) {
      var pre = 'f' + i + ':', base = dowIdx(f.start) * 24;
      f.tasks.forEach(function (t) {
        var c = {}, k;
        for (k in t) if (has(t, k)) c[k] = t[k];
        c.id = pre + t.id;
        c.after = (t.after || []).map(function (a) { return pre + a; });
        c.journey = f.name + ' \u00b7 ' + cutLabel(f.start);
        // Slide the whole journey along by how far its cut sits from Sunday,
        // keeping the order it was written in. Reading each leg's weekday
        // straight off the calendar instead would fold a journey that runs
        // past Saturday back to the left of the chart, and it would deliver
        // before it packed.
        c.s = base + t.s;
        c.e = base + t.e;
        tasks.push(c);
      });
      (f.branches || []).forEach(function (b) { if (branches.indexOf(b) < 0) branches.push(b); });
      for (var p in f.windows) if (has(f.windows, p)) windows[p] = f.windows[p];
    });
    return { id: 'many', name: 'many', start: 'Sun', many: list.length,
      branches: branches, tasks: tasks, windows: windows };
  }

  // The name on the chart is the name on the button, so a thread and the thing
  // that selected it read as the same thing.
  function threadName(def) {
    for (var i = 0; i < F.length; i++) if (F[i].name === def) return jrnLabel(F[i]);
    return def;
  }


  // How much of a run happened before its first step: a crop that holds may
  // already have been packed days earlier, and the sheet has no column for
  // which day any particular case was. reference.json names the earliest
  // weekday per crop and cut; the gap between that and where the run starts is
  // what the count could stretch back by. Nothing here moves a bar -- the chart
  // still draws the legs it was given.
  function packBack(f, r) {
    var by = ((window.REF || {}).packed_from || {})[f.crop || ''];
    if (!by) return 0;
    var from = DOW.indexOf(by[f.start] || '');
    if (from < 0) return 0;
    var first = (dowIdx(f.start) + dayOf(r.start) % 7 + 7) % 7;
    return ((first - from) % 7 + 7) % 7;
  }

  // Every run behind a chip that the cut-day choice lets through: first step to
  // last stop in days, widened at the far end by however long the crop may
  // already have been sitting. The runs collapse to one span, lowest start to
  // longest end -- the two cuts wait different lengths for the same boat, so a
  // journey reads as the whole of what it can be rather than one of its halves.
  function daysOf(key) {
    var when = (S.sel || {}).when || [];
    var runs = F.filter(function (f) {
      return jrnKey(f) === key && (!when.length || when.indexOf(f.start) >= 0);
    });
    var lo = null, hi = null;
    runs.forEach(function (f) {
      var r = read(f), a = r.days, b = r.days + packBack(f, r);
      if (lo === null || a < lo) lo = a;
      if (hi === null || b > hi) hi = b;
    });
    if (lo === null) return '';
    return '(' + (hi > lo ? lo + '\u2013' + hi : lo) + ')';
  }

  function jrnFor(key) {
    for (var i = 0; i < F.length; i++) if (jrnKey(F[i]) === key) return F[i];
    return null;
  }
  function idxOf(f) { return F.indexOf(f); }
  function fobRank(f) {
    for (var i = 0; i < F.length; i++) if ((F[i].fob || '') === (f.fob || '')) return i;
    return F.length;
  }

  function toggle(key, v) {
    var list = (S.sel[key] || []).slice(), at = list.indexOf(v);
    if (at < 0) list.push(v); else list.splice(at, 1);
    S.sel[key] = list;
    save();
    paint();
  }

  function picker() {
    // One answer is not a question -- that is what keeps a cut toggle away
    // from a crop that is only cut once.
    var when = uniq(F.map(function (f) { return f.start; }));
    seg('pick-when', when.length > 1 ? when.map(function (d) { return [d, cutLabel(d)]; }) : [],
      S.sel.when || [], function (v) { toggle('when', v); });

    // A row of journeys per crop. They are separate questions -- nobody asks
    // for the lettuce 140 and the cucumber Oahu in one breath -- and grouping
    // them says which crop a journey belongs to without a word for it.
    var host = document.getElementById('pick-jrns');
    if (!host) return;
    var crops = uniq(F.map(function (f) { return f.crop || ''; }));
    host.innerHTML = crops.map(function (c, n) {
      return '<span class="lbl">' + esc(c) + '</span><span class="seg" id="pick-c' + n +
        '"></span>';
    }).join('');
    crops.forEach(function (c, n) {
      var mine = F.filter(function (f) { return (f.crop || '') === c; });
      // Journeys to the same customer sit together: 140 twice over is one
      // choice made twice, and reads that way only side by side.
      var rank = {};
      mine.forEach(function (f) {
        var k = f.fob || '';
        if (!has(rank, k)) rank[k] = mine.indexOf(f);
      });
      var opts = uniq(mine.map(jrnKey)).sort(function (a, b) {
        var fa = jrnFor(a), fb = jrnFor(b);
        if (!fa || !fb) return 0;
        var ga = rank[fa.fob || ''], gb = rank[fb.fob || ''];
        return ga !== gb ? ga - gb : mine.indexOf(fa) - mine.indexOf(fb);
      });
      // In the journey's own colour, and in the stronger of its two shades: a
      // chip is the journey, not one run of it. Colour is the whole point of
      // the chip -- it is how you find that thread again in the chart.
      //
      // Under the name, how many days it takes. It used to be one figure beside
      // the row, which meant it existed only while exactly one journey was on;
      // per chip it is there for all of them at once, which is the comparison
      // the row is for. A chip covers both cut days, so a journey whose two
      // runs differ -- Kauai catches a different boat off each -- reads as a
      // range rather than picking one.
      seg('pick-c' + n, opts.map(function (k) {
        var f = jrnFor(k);
        return [k, f ? jrnLabel(f) : k, f ? 'j' + hueOf(f.name) + 'a' : '', daysOf(k)];
      }), S.sel.jrn || [], function (v) { toggle('jrn', v); });
    });
  }

  function seg(id, opts, sel, cb) {
    var el = document.getElementById(id);
    if (!el) return;
    el.style.display = opts.length ? '' : 'none';
    var chosen = Object.prototype.toString.call(sel) === '[object Array]' ? sel : [sel];
    el.innerHTML = opts.map(function (o) {
      var on = chosen.some(function (c) { return String(o[0]) === String(c); });
      var tone = o[2] ? ' ' + o[2] : '';
      var sub = o[3] ? '<small>' + esc(o[3]) + '</small>' : '';
      return '<a data-v="' + esc(o[0]) + '" class="' + esc((on ? 'on' : '') + tone) +
        '">' + esc(o[1]) + sub + '</a>';
    }).join('');
    [].slice.call(el.querySelectorAll('a')).forEach(function (a) {
      a.onclick = function () { cb(a.getAttribute('data-v')); };
    });
  }

  // Nothing to say when the sheet was read: that is the normal case and the
  // chart is the answer. The line exists for when it was not, because stale
  // legs drawn silently would be worse than no line at all.
  function srcLine() {
    // A journey that could not be built is worth a line even when the rest of
    // the sheet read fine, or it just quietly is not there.
    var hurt = (SRC.hurt || []).map(function (h) {
      return '<span class="warn-in">' + esc(h) + '</span>';
    }).join(' ');
    if (SRC.live || !SRC.why) return hurt;
    return 'Sheet unreadable (' + esc(SRC.why) + ') — showing the snapshot in ' +
      '<code>legs.csv</code>. ' + hurt;
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  // Draw the snapshot at once so the page is never blank, then read the sheet
  // and redraw if it is there. A journey the reader has already picked stays
  // picked across the swap.
  function useText(text, live, why) {
    var built;
    try {
      // Two shapes, one reader: a row per leg, or the grid of steps by
      // journey. Only the row shape carries a Start dt column, because only it
      // needs one -- the grid puts both times in a cell.
      var raw = csvRows(text), rowish = false;
      raw.forEach(function (r) {
        r.forEach(function (c) { if (c.trim().toLowerCase() === 'start dt') rowish = true; });
      });
      var legs = rowish ? legRows(text) : gridRows(text);
      built = buildFlows(legs).filter(function (f) { return !isHidden(f); });
      built.hurt = legs.hurt || [];
    } catch (err) {
      why = String((err && err.message) || err);
      // A typo in the sheet must not take the page down with it: fall back to
      // the snapshot and say why on the line above the chart.
      if (live) { useText(window.LEGS || '', false, why); return; }
      built = [];
      live = false;
    }
    F = built;
    SRC = { live: live, at: new Date(), why: why || '', hurt: built.hurt || [] };
    // A stored answer that the sheet no longer offers is dropped rather than
    // silently narrowing the picture to nothing.
    var fresh = !S.sel;
    S.sel = S.sel || {};
    var have = {};
    KEYS.forEach(function (k) { have[k] = uniq(F.map(function (f) { return facets(f)[k]; })); });
    KEYS.forEach(function (k) {
      S.sel[k] = (S.sel[k] || []).filter(function (v) { return have[k].indexOf(v) >= 0; });
    });
    // Open on one journey rather than on everything at once -- but only on a
    // session that had nothing stored. An answer the sheet stopped offering
    // gets dropped; that is the reader clearing a toggle, not a fresh start,
    // and reseeding over it would put back a choice they had let go.
    if (fresh && F.length) {
      var first = facets(F[0]);
      KEYS.forEach(function (k) { S.sel[k] = first[k] ? [first[k]] : []; });
    }
    paint();
  }

  useText(window.LEGS || '', false, '');
  var SHEET = window.SHEET || '';
  if (SHEET && window.fetch) {
    window.fetch(SHEET, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }).then(function (t) {
      useText(t, true, '');
    })['catch'](function (e) {
      SRC.why = String((e && e.message) || e);
      if (S.tab === 'flow') document.getElementById('src').innerHTML = srcLine();
    });
  }
})();
