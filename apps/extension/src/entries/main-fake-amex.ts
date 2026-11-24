/** Fake American Express MAIN passive observer (test build only). */
import { FAKE_AMEX_MAIN } from '../adapters/fake/amex/main.js';
import { installObserver } from '../main/observer.js';

installObserver(FAKE_AMEX_MAIN, 'sync');
