export { ArchitectureDiagram } from './components/ArchitectureDiagram';
export { useDiagram } from './hooks/useDiagram';
export { LuNetwork as DiagramIcon } from 'react-icons/lu';
export { diagramFeature, DiagramFeature } from './DiagramFeature';

import { diagramFeature } from './DiagramFeature';
import { registerFeature } from '../featureRegistry';
registerFeature(diagramFeature);
