import assert from 'node:assert/strict';
import { test } from 'node:test';

import { categoryShortLabel, categoryTone } from './category';

test('issuers\' names for the same kind of spending share a tone, by their top level first', () => {
  const cases: Array<[string, string]> = [
    ['Groceries', 'groceries'], ['Supermarkets', 'groceries'],
    ['Food & Drink', 'dining'], ['Restaurant-Dining', 'dining'], ['Restaurant-Coffee', 'dining'], ['Restaurants', 'dining'],
    ['Restaurant-Bar & Café', 'dining'],
    ['Travel', 'travel'], ['Travel-Airline', 'travel'], ['Travel-Lodging', 'travel'],
    ['Gas', 'gas'], ['Transportation-Fuel', 'gas'], ['Gas Stations', 'gas'], ['Automotive', 'gas'],
    ['Entertainment', 'entertainment'], ['Subscriptions', 'entertainment'], ['Entertainment-Associations', 'entertainment'],
    ['Bills & Utilities', 'bills'], ['Utilities', 'bills'],
    ['Health & Wellness', 'health'], ['Home', 'home'],
    ['Fees & Adjustments', 'fees'], ['Fees & Adjustments-Fees & Adjustments', 'fees'],
    ['Shopping', 'shopping'], ['Merchandise-Books', 'shopping'], ['Merchandise-Sporting Goods', 'shopping'],
    // The chip reads "Merchandise", so its colour is Merchandise's too.
    ['Merchandise-Groceries', 'shopping'], ['Merchandise & Supplies-Groceries', 'shopping'],
    ['Merchandise & Supplies-Internet Purchase', 'shopping'],
    ['Uncategorized', 'none'], ['', 'none'], ['  ', 'none'],
  ];
  for (const [name, tone] of cases) assert.equal(categoryTone(name), tone, name);
});

test('any other name always gets the same spare tone, whatever its case or spacing', () => {
  const tone = categoryTone('Date night');
  assert.match(tone, /^c[0-5]$/);
  assert.equal(categoryTone('date night'), tone);
  assert.equal(categoryTone(' Date night '), tone);
  assert.match(categoryTone('Business Services-Advertising Services'), /^c[0-5]$/);
  const spread = new Set(['Pets', 'Kids', 'Charity', 'Hobbies', 'Education', 'Childcare', 'Taxes', 'Personal care'].map(categoryTone));
  assert.ok(spread.size >= 3, `spare tones spread: ${[...spread].join(', ')}`);
});

test('a chip shows the issuer\'s top level, shortened only when long', () => {
  const cases: Array<[string, string]> = [
    ['Merchandise & Supplies-Groceries', 'Merchandise'],
    ['Merchandise & Supplies-Internet Purchase', 'Merchandise'],
    ['Restaurant-Bar & Café', 'Restaurant'],
    ['Travel-Airline', 'Travel'],
    ['Business Services-Advertising Services', 'Business Services'],
    ['Food & Drink', 'Food & Drink'],
    ['Bills & Utilities', 'Bills & Utilities'],
    ['Health & Wellness Services Extra', 'Health'],
    ['E-Commerce', 'E-Commerce'],
    ['Date night', 'Date night'],
    ['  Groceries ', 'Groceries'],
  ];
  for (const [name, label] of cases) assert.equal(categoryShortLabel(name), label, name);
});
