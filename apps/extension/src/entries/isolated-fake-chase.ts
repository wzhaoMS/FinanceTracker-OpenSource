/** Fake Chase ISOLATED collector (test build only). */
import { FAKE_CHASE_ISOLATED } from '../adapters/fake/chase/isolated.js';
import { runCollector } from '../isolated/collector.js';

runCollector(FAKE_CHASE_ISOLATED);
