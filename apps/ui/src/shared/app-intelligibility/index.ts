/**
 * Spec #3244 — the app-intelligibility module (ST-1, the sole creator).
 *
 * The ONE seam that turns an application's declared description into a resolved
 * `AppDescription`, or the typed `noDescription` failure. Later capsules
 * (ST-3/ST-4/ST-6) add their own files to this module (the capture seam, the
 * screen-outline projector, the measurement surface) and re-export them here —
 * no other stream re-declares this module.
 */

export {
  locateAppDescriptionSource,
  resolveAppDescription,
} from './description';
export type {
  AppDescription,
  AppDescriptionOrigin,
  AppDescriptionResolution,
  AppDescriptionSource,
  AppIntelligibilityFailure,
} from './description';

// Spec #3244 ST-4 — the screen-outline projector (the injected pair's DOM leg).
// ONE added re-export line; the module itself is ST-1's and nothing else here
// changes.
export * from './screenOutline';

// Spec #3244 ST-6 — the screen-read measurement surface (AC-4). ONE added
// re-export line; the module itself is ST-1's and nothing else here changes.
export * from './measurement';

// Spec #3244 ST-7 — the installed-tier outline fetch (the host correlation seam).
// ONE added re-export line; the module itself is ST-1's and nothing else here
// changes.
export { requestInstalledOutline } from './installedOutline';
export type { OutlineReply } from './installedOutline';
