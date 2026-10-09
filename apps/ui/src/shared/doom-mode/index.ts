/**
 * Shared frontend Doom Mode client (Spec #2970, ST-5).
 *
 * The ONE barrel for the secret-activation frontend contract: the wire mirror
 * (`types`), the module-scoped suppression gate (`performanceGate`), the
 * module-scoped Doom visual store (`doomVisual`), the mode client
 * (`useDoomMode`), the companion dispatcher (`useDoomModeSkill`), and the
 * first-use engine provisioning contract (`provision` mirror +
 * `useDoomProvision`, Spec #3012 ST-4).
 * ST-6 mounts these in `HomeDesktop`.
 */
export * from './types';
export * from './performanceGate';
export * from './doomVisual';
export * from './useDoomMode';
export * from './useDoomModeSkill';
export * from './provision';
export * from './useDoomProvision';
