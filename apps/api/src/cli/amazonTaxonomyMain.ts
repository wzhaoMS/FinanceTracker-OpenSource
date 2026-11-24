import { runAmazonTaxonomyCli } from './amazonTaxonomy.js';

process.exitCode = await runAmazonTaxonomyCli(process.argv.slice(2), { env: process.env, io: process });
