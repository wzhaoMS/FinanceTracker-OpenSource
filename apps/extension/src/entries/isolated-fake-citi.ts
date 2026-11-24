/** Fake Citi ISOLATED collector (test build only). */
import { FAKE_CITI_ISOLATED } from '../adapters/fake/citi/isolated.js';
import { runCollector } from '../isolated/collector.js';

runCollector(FAKE_CITI_ISOLATED);
