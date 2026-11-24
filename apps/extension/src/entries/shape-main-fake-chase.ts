/** Fake Chase MAIN shape observer (test build only). */
import { FAKE_CHASE_SHAPE } from '../adapters/fake/chase/shape.js';
import { installObserver } from '../main/observer.js';

installObserver(FAKE_CHASE_SHAPE, 'shape');
