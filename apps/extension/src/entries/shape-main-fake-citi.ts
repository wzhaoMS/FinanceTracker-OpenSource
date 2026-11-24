/** Fake Citi MAIN shape observer (test build only). */
import { FAKE_CITI_SHAPE } from '../adapters/fake/citi/main.js';
import { installObserver } from '../main/observer.js';

installObserver(FAKE_CITI_SHAPE, 'shape');
