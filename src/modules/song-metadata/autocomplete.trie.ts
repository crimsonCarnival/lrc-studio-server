import { Trie } from '@crimson-carnival/ds-js';

const MAX_TERMS = 10_000
const trie = new Trie();

export function insertAutocompleteTerms(terms: string[]): void {
  for (const term of terms) {
    if (trie.size >= MAX_TERMS) return
    if (term.trim()) trie.insert(term.toLowerCase().trim());
  }
}

export function getAutocompleteSuggestions(prefix: string): string[] {
  if (!prefix || prefix.length < 1) return [];
  return trie.wordsWithPrefix(prefix.toLowerCase().trim()).slice(0, 10);
}
