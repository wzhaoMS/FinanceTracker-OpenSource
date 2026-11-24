/** Fake American Express ISOLATED collector (test build only). */
import { FAKE_AMEX_ISOLATED } from '../adapters/fake/amex/isolated.js';
import { runCollector } from '../isolated/collector.js';

runCollector(FAKE_AMEX_ISOLATED);
