"""Build index.html from templates/, shared.js, style.css and data.json.

Touches no network and needs no credentials -- everything it reads is on disk.
Run extract.py first if the shipping history needs refreshing; run this on its
own after editing a template, a style or the shared engine.
"""
import json
import os
import re

here = os.path.dirname(os.path.abspath(__file__))
out = json.load(open(os.path.join(here, "data.json")))
data_js = "window.FREIGHT_DATA = %s;" % json.dumps(out, separators=(",", ":"))

# Everything ends up in one index.html: the data, shared.js and the stylesheet
# each appear once, so there is nothing to link and nothing to duplicate. One
# file also means it opens by double-clicking and travels as a single
# attachment, which the eight-page version never did.
here = os.path.dirname(os.path.abspath(__file__))
data_js = "window.FREIGHT_DATA = %s;" % json.dumps(out, separators=(",", ":"))

# The nav is the argument: three decisions in the order they are made, then the
# working behind them. One list, built once, so no page can drift from another.
PAGES = [
    ("lettuce.html",   "lettuce",   "Lettuce"),
    ("annual.html",    "annual",    "Cucumbers"),
    ("shorts.html",    "shorts",    "Shorts"),
    ("trucks.html",    "trucks",    "Trucks"),
    ("weights.html",   "weights",   "Weights"),
]


# One file. Every page is a section of it, shown a tab at a time, and the data,
# the shared code and the stylesheet are each present exactly once -- which is
# the same reason the pages stopped inlining them, reached from the other side.
#
# The pages were written as separate documents and each one owns element ids;
# ten of those ids appear on more than one page (`notes` on seven of them). So
# rather than renaming ids across eight templates, each page's script gets a
# `document` that only ever looks inside that page's own section. It shadows the
# real one for the length of the IIFE, which is exactly the scope that used to
# BE the document.
SLUG_RE = re.compile(r'href="([a-z]+)\.html((?:\?[^"]*)?)"')


def page_parts(path, slug):
    """The page's markup and its script, ready to drop into the one file."""
    src = open(path).read()

    body = src[src.index("<body>") + len("<body>"): src.index("\n<script")]
    script = src[src.index("\n<script>\n(function"):src.rindex("</script>")]
    script = script[script.index("(function"):]

    # Links between pages become tab switches; ?dt= rides along in the hash.
    def relink(m):
        target, query = m.group(1), m.group(2)
        target = "annual" if target == "freight" else target
        dt = re.search(r"dt=([^&\"]+)", query)
        return 'href="#%s%s" data-go="%s"' % (target, ("/" + dt.group(1)) if dt else "", target)

    body = SLUG_RE.sub(relink, body)
    script = SLUG_RE.sub(relink, script)

    # A page reads ?dt= for the sailing it shows; the hash carries it now.
    script = script.replace("window.location.search", "pageArg()").replace("location.search", "pageArg()")

    shim = (
        '  var __root = window.document.getElementById("page-%s");\n'
        '  var document = {\n'
        '    getElementById: function (id) { return __root.querySelector(\'[id="\' + id + \'"]\'); },\n'
        '    querySelector: function (q) { return __root.querySelector(q); },\n'
        '    querySelectorAll: function (q) { return __root.querySelectorAll(q); },\n'
        '    createElement: function (t) { return window.document.createElement(t); }\n'
        '  };\n'
    ) % slug
    script = script.replace('  "use strict";\n', '  "use strict";\n' + shim, 1)
    return body, script


nav = "".join(
    '<a href="#%s" data-go="%s">%s</a>' % (slug, slug, label) for _t, slug, label in PAGES
)

sections, scripts = [], []
for tpl_name, slug, _label in PAGES:
    body, script = page_parts(os.path.join(here, "templates", tpl_name), slug)
    body = body.replace("/*__NAV__*/", nav)
    sections.append('<div class="page" id="page-%s">%s</div>' % (slug, body))
    scripts.append("<script>\n%s\n</script>" % script)

router = """
(function () {
  "use strict";
  // #slug, or #slug/2026-08-18 where a page shows one sailing.
  var PAGES = [%s];
  function parse() {
    var h = (location.hash || '').replace(/^#/, '').split('/');
    return { page: PAGES.indexOf(h[0]) >= 0 ? h[0] : PAGES[0], arg: h[1] || '' };
  }
  window.pageArg = function () { return parse().arg ? '?dt=' + parse().arg : ''; };
  function show() {
    var want = parse().page;
    PAGES.forEach(function (p) {
      document.getElementById('page-' + p).style.display = p === want ? '' : 'none';
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-go]'), function (a) {
      a.classList.toggle('on', a.getAttribute('data-go') === want);
    });
    document.title = (document.querySelector('#page-' + want + ' h1') || {}).textContent ||
      'Freight Model';
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', function () { show(); window.dispatchEvent(new Event('pagechange')); });
  window.__showPage = show;
})();
""" % ", ".join("'%s'" % slug for _t, slug, _l in PAGES)

out_html = """<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Freight Model</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap">
<style>
%s
</style>
</head>
<body>
%s
<script>
%s
</script>
<script>
%s
</script>
<script>%s</script>
%s
<script>window.__showPage();</script>
</body>
</html>
""" % (
    open(os.path.join(here, "style.css")).read(),
    "\n".join(sections),
    data_js,
    open(os.path.join(here, "shared.js")).read(),
    router,
    "\n".join(scripts),
)

# The page is published one level up, which is the path the dash hub iframes.
# Writing it straight there is what keeps the built file and the source that
# made it from drifting -- it used to be built here and copied over by hand,
# and a forgotten copy meant the dash showed the previous week's model.
index = os.path.normpath(os.path.join(here, os.pardir, "index.html"))
with open(index, "w") as fh:
    fh.write(out_html)
print(f"wrote {index}  ({len(out_html) / 1024:.0f} KB, {len(PAGES)} pages)")
