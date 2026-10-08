export { TerminalFeature } from './TerminalFeature';
export { TerminalWindow } from './components/TerminalWindow';

import { TerminalFeature } from './TerminalFeature';
import { registerApplication } from '../applicationRegistry';
export const terminalFeature = new TerminalFeature();
registerApplication(terminalFeature);
