// Holdr Card Sync service worker: everything happens in worker-core.mjs.
import { createWorker } from './worker-core.mjs';

const worker = createWorker({ chromeApi: chrome });
chrome.runtime.onMessage.addListener(worker.onMessage);
