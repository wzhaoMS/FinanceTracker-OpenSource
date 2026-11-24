/** Generic ISOLATED relay for shape mode. */
import { TARGET } from '#target';
import { runShapeRelay } from '../isolated/shapeRelay.js';

runShapeRelay(TARGET.adapters.map((adapter) => ({ id: adapter.id, label: adapter.label, pageOrigin: adapter.pageOrigin, shapeContracts: adapter.shapeContracts })));
