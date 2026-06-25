import { Trie } from '@crimson-carnival/ds-js';

const trie = new Trie();

export function insertAutocompleteTerms(terms: string[]): void {
  for (const term of terms) {
    if (term.trim()) trie.insert(term.toLowerCase().trim());
  }
}

export function getAutocompleteSuggestions(prefix: string): string[] {
  if (!prefix || prefix.length < 1) return [];
  return trie.wordsWithPrefix(prefix.toLowerCase().trim()).slice(0, 10);
}
