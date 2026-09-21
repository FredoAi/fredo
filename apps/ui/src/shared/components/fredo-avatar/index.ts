export { FredoAvatar } from './FredoAvatar';
export type { FredoAvatarProps, FredoAvatarState } from './FredoAvatar';
export { FREDO_AVATAR_STATES, isFredoAvatarState } from './fredoAvatarStates';
export {
  FREDO_AVATAR_SPACE,
  FREDO_AVATAR_VIEWBOX,
  FREDO_AVATAR_SOURCE_RECTS,
  FREDO_AVATAR_INTERIOR_RECTS,
  expandFredoRects,
  buildInteriorPathD,
} from './fredoAvatarGeometry';
export type { FredoRect, FredoAvatarSourceRect } from './fredoAvatarGeometry';
export { AVATAR_SM, AVATAR_MD, AVATAR_SIZE, AVATAR_SM_CSS, toCssPx } from './fredoAvatarSizes';
export type { FredoAvatarSize } from './fredoAvatarSizes';
