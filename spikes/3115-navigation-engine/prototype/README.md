# Navigation prototype (Issue 3115)

THROWAWAY — deleted by P8. This directory is not the product.

Open `index.html` directly in a browser (no server, no install). It loads only `./prototype.css`
and `./prototype.js`, so it works from `file://`.

## What this shows

A low-fidelity greybox of the proposed place model:

- the Canvas place tree and its six child places;
- the direct aliases on the root and the contextual rail with a breadcrumb;
- the navigation map behind `?`;
- actions that respond to the current selection;
- the place-scoped launcher with a natural-language reply and a grouped action palette;
- an attributed undo for a change made by the companion.

This is a research stimulus, not a product surface. It is deliberately unstyled by the app theme,
has no persistence, writes no file, and makes no network call. Reload restores the load state.
