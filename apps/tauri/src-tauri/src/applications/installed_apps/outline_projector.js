/*!
 * Spec #3244 ST-7 — the screen-outline projector, the INSTALLED-TIER CARRIER.
 *
 * This file is host-authored, embedded with `include_str!` and shipped into an
 * installed-app document AS PART OF the eval statement the host `eval`s
 * (`beacon.rs::report_statement`). It defines exactly one global,
 * `window.__FREDO_SIMPLIFY_DOM__(root, maxNodes)`, which the host-authored
 * reporter in `bootstrap.js` (`window.__FREDO_REPORT_OUTLINE__`) calls.
 *
 * # Why a JS carrier exists at all (disclosed, not hidden)
 *
 * The ONE algorithm is ST-4's TypeScript `simplifyDom`
 * (`apps/ui/src/shared/app-intelligibility/screenOutline.ts`), which the
 * MAIN webview runs directly on its own DOM. A SEPARATE installed-app webview
 * cannot import that module — it is a plain WebView2 document with no bundler —
 * so the same algorithm is carried here as JavaScript. The two carriers are held
 * in lockstep by a committed Rust contract pin
 * (`beacon.rs::tests::the_installed_carrier_and_the_main_webview_projector_agree`),
 * which reads BOTH sources and refuses a drift in the node cap, the name
 * precedence, or the skipped/interactive tag sets.
 *
 * The projection contract is byte-for-byte the main-webview carrier's: emit a
 * node ONLY when its accessible name is non-empty; the name precedence is
 * `aria-label` -> `alt` -> `title` -> `placeholder` -> visible text; a hidden
 * element (or one inside a skipped tag) contributes nothing and its subtree is
 * not walked; `truncated` is set when the node cap drops nodes. Pure: reads the
 * DOM and returns a value, no I/O.
 */
window.__FREDO_SIMPLIFY_DOM__ = (function () {
  "use strict";

  // Mirrors `screenOutline.ts:SCREEN_OUTLINE_MAX_NODES` (the cap `simplifyDom`
  // enforces). The agent passes the live ceiling so the two cannot diverge.
  var MAX_NAME_CHARS = 120;

  var SKIPPED_TAGS = {
    SCRIPT: true,
    STYLE: true,
    NOSCRIPT: true,
    TEMPLATE: true,
    HEAD: true,
    META: true,
    LINK: true,
    TITLE: true,
    BR: true,
    WBR: true
  };

  var TAG_ROLES = {
    A: "link",
    BUTTON: "button",
    SELECT: "combobox",
    TEXTAREA: "textbox",
    IMG: "img",
    H1: "heading",
    H2: "heading",
    H3: "heading",
    H4: "heading",
    H5: "heading",
    H6: "heading",
    UL: "list",
    OL: "list",
    LI: "listitem",
    TABLE: "table",
    TR: "row",
    TD: "cell",
    TH: "columnheader",
    NAV: "navigation",
    MAIN: "main",
    HEADER: "banner",
    FOOTER: "contentinfo",
    FORM: "form",
    LABEL: "label",
    P: "paragraph",
    SECTION: "region",
    DIALOG: "dialog",
    SUMMARY: "button"
  };

  var INTERACTIVE_TAGS = {
    A: true,
    BUTTON: true,
    INPUT: true,
    SELECT: true,
    TEXTAREA: true,
    SUMMARY: true,
    OPTION: true,
    LABEL: true
  };

  function collapseWhitespace(value) {
    return value.replace(/\s+/g, " ").trim();
  }

  function clipName(value) {
    return value.length > MAX_NAME_CHARS ? value.slice(0, MAX_NAME_CHARS) : value;
  }

  function textName(element) {
    var tag = element.tagName.toUpperCase();
    var interactive = element.hasAttribute("role") || INTERACTIVE_TAGS[tag] === true;
    if (!interactive && element.children.length > 0) return "";
    return collapseWhitespace(element.textContent || "");
  }

  function accessibleName(element) {
    var candidates = ["aria-label", "alt", "title", "placeholder"];
    for (var index = 0; index < candidates.length; index += 1) {
      var value = element.getAttribute(candidates[index]);
      if (value !== null && collapseWhitespace(value) !== "") {
        return clipName(collapseWhitespace(value));
      }
    }
    var text = textName(element);
    return text === "" ? "" : clipName(text);
  }

  function elementRole(element) {
    var explicit = element.getAttribute("role");
    if (explicit !== null && collapseWhitespace(explicit) !== "") {
      return collapseWhitespace(explicit);
    }
    var tag = element.tagName.toUpperCase();
    if (tag === "INPUT") {
      var type = (element.getAttribute("type") || "text").toLowerCase();
      if (type === "button" || type === "submit" || type === "reset") return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      return "textbox";
    }
    return TAG_ROLES[tag] || "generic";
  }

  function elementBox(element) {
    if (typeof element.getBoundingClientRect !== "function") return [0, 0, 0, 0];
    var rect = element.getBoundingClientRect();
    return [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)];
  }

  function buildNode(element, name) {
    var node = {
      role: elementRole(element),
      name: name,
      tag: element.tagName.toLowerCase(),
      bbox: elementBox(element)
    };
    var rawTestId = element.getAttribute("data-testid");
    if (rawTestId !== null && rawTestId.trim() !== "") {
      node.testid = rawTestId.trim();
    }
    return node;
  }

  function isSkipped(element) {
    if (SKIPPED_TAGS[element.tagName.toUpperCase()] === true) return true;
    if (element.hidden === true) return true;
    return element.getAttribute("aria-hidden") === "true";
  }

  return function simplifyDom(root, maxNodes) {
    var cap = Number.isFinite(maxNodes) ? Math.max(0, Math.floor(maxNodes)) : 0;
    var nodes = [];
    var truncated = false;

    function walk(element) {
      if (isSkipped(element)) return;
      var name = accessibleName(element);
      if (name !== "") {
        if (nodes.length < cap) nodes.push(buildNode(element, name));
        else truncated = true;
      }
      for (var index = 0; index < element.children.length; index += 1) {
        var child = element.children.item(index);
        if (child !== null) walk(child);
      }
    }

    walk(root);
    return { nodes: nodes, truncated: truncated };
  };
})();
