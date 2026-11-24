/**
 * The v1 grammars of a card import's provenance, enforced by the repository
 * since v13: a lowercase source slug (`amex-csv`) and a parser version
 * (`csv@1.0.0`). The v15 migration re-checks stored values against them
 * (design §3.1 precondition P5), because v15's tables CHECK the same shape.
 */
export const CARD_SLUG = /^[a-z][a-z0-9-]{0,31}$/;
export const CARD_PARSER_VERSION = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,63}$/;
