/** Fake Citi MAIN passive observer (test build only). */
import { FAKE_CITI_MAIN } from '../adapters/fake/citi/main.js';
import { installObserver } from '../main/observer.js';

installObserver(FAKE_CITI_MAIN, 'sync');
