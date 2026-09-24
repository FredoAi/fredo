export { TerminalFeature } from './TerminalFeature';
export { TerminalWindow } from './components/TerminalWindow';

import { TerminalFeature } from './TerminalFeature';
import { registerFeature } from '../featureRegistry';
export const terminalFeature = new TerminalFeature();
registerFeature(terminalFeature);
