/** Fake Wells Fargo ISOLATED collector, rendered DOM only (test build only). */
import { FAKE_WF_ISOLATED } from '../adapters/fake/wellsfargo/isolated.js';
import { runCollector } from '../isolated/collector.js';

runCollector(FAKE_WF_ISOLATED);
