/** Fake American Express MAIN shape observer (test build only). */
import { FAKE_AMEX_SHAPE } from '../adapters/fake/amex/main.js';
import { installObserver } from '../main/observer.js';

installObserver(FAKE_AMEX_SHAPE, 'shape');
