/**
 * Doom feature barrel (Spec #2970 ST-6).
 *
 * Doom Mode is a SECRET: it must leave NO discoverable trace before activation
 * (AC3). The feature is therefore no longer registered with `registerApplication`,
 * and the `DoomFeature`/`DoomEntry` main-window entry host is deleted — there is
 * no launcher tile, settings row, search result, palette entry, or in-window
 * control.
 *
 * Only the `doom` window component is exported: it is reached exclusively by the
 * `?view=doom` route (opened by the Rust `open_doom_window` command from
 * `enter_doom_mode`), never by a user-discoverable affordance.
 */
export { DoomWindow } from './DoomWindow';
