/**
 * Shared frontend Doom Mode client (Spec #2970, ST-5).
 *
 * The ONE barrel for the secret-activation frontend contract: the wire mirror
 * (`types`), the module-scoped suppression gate (`performanceGate`), the
 * module-scoped Doom visual store (`doomVisual`), the mode client
 * (`useDoomMode`), and the companion dispatcher (`useDoomModeSkill`).
 * ST-6 mounts these in `HomeDesktop`.
 *
 * Spec #3023 ST-7 — the first-use engine provisioning contract
 * (`provision` mirror + `useDoomProvision`) was removed with the from-source
 * engine path; activation is direct.
 */
export * from './types';
export * from './performanceGate';
export * from './doomVisual';
export * from './useDoomMode';
export * from './useDoomModeSkill';
