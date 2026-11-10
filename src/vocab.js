'use strict';
/**
 * The label vocabulary for open-vocabulary matching.
 *
 * CLIP scores a crop against these prompts. They are deliberately concrete and
 * plural-aware where it matters ("a pair of scissors" beats "scissors").
 * Operators can replace this list in Settings — that is the point of the
 * feature: "sharpie" and "marker" are not COCO classes, but they are words.
 */

const DEFAULT_VOCABULARY = [
  'a person',
  'a chair',
  'a desk',
  'a table',
  'a laptop',
  'a keyboard',
  'a mouse',
  'a monitor',
  'a phone',
  'a cup',
  'a bottle',
  'a pen',
  'a pencil',
  'a marker',
  'a pair of scissors',
  'a toothbrush',
  'a screwdriver',
  'a knife',
  'a spoon',
  'a cardboard box',
  'a backpack',
  'a bag',
  'a book',
  'a notebook',
  'a piece of paper',
  'a pair of glasses',
  'a pair of headphones',
  'a wallet',
  'keys',
  'a remote control',
  'a cable',
  'a plant',
  'a lamp',
  'a door',
  'a window',
  'a shelf',
];

const ARTICLE = /^(a|an|the)\s+/i;

function displayLabel(prompt) {
  return String(prompt).replace(ARTICLE, '').trim();
}

function buildPrompt(label) {
  const text = String(label || '').trim();
  if (!text) return '';
  return ARTICLE.test(text) ? text : `a ${text}`;
}

/** Normalise whatever is stored in settings into a clean prompt list. */
function normaliseVocabulary(value) {
  if (!Array.isArray(value)) return DEFAULT_VOCABULARY.slice();
  const seen = new Set();
  const out = [];
  for (const entry of value) {
    const prompt = String(entry || '').trim();
    if (!prompt || prompt.length > 60) continue;
    const key = prompt.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(prompt);
  }
  return out.length ? out.slice(0, 120) : DEFAULT_VOCABULARY.slice();
}

module.exports = { DEFAULT_VOCABULARY, displayLabel, buildPrompt, normaliseVocabulary };
