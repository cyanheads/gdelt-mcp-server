/**
 * @fileoverview GDELT DOC's language lookup (`LOOKUP-LANGUAGES.TXT`, the 65 machine-translated
 * languages) plus English, as the GKG mirror resolves `sourcelang:` and names languages in
 * artlist and `timelinelang` output. Each code is both the three-letter code DOC's `sourcelang:`
 * accepts and the `srclc:` code GKG's translingual feed writes (`axe` for Azerbaijani included);
 * English-feed rows are stored as `eng`.
 * @module services/gkg-mirror/languages
 */

/** DOC languages: `code` is the stored `language` value, `name` is DOC's display name. */
const DOC_LANGUAGES = [
  { code: 'eng', name: 'English' },
  { code: 'afr', name: 'Afrikaans' },
  { code: 'sqi', name: 'Albanian' },
  { code: 'ara', name: 'Arabic' },
  { code: 'hye', name: 'Armenian' },
  { code: 'axe', name: 'Azerbaijani' },
  { code: 'ben', name: 'Bengali' },
  { code: 'bos', name: 'Bosnian' },
  { code: 'bul', name: 'Bulgarian' },
  { code: 'cat', name: 'Catalan' },
  { code: 'zho', name: 'Chinese' },
  { code: 'hrv', name: 'Croatian' },
  { code: 'ces', name: 'Czech' },
  { code: 'dan', name: 'Danish' },
  { code: 'nld', name: 'Dutch' },
  { code: 'est', name: 'Estonian' },
  { code: 'fin', name: 'Finnish' },
  { code: 'fra', name: 'French' },
  { code: 'glg', name: 'Galician' },
  { code: 'kat', name: 'Georgian' },
  { code: 'deu', name: 'German' },
  { code: 'ell', name: 'Greek' },
  { code: 'guj', name: 'Gujarati' },
  { code: 'heb', name: 'Hebrew' },
  { code: 'hin', name: 'Hindi' },
  { code: 'hun', name: 'Hungarian' },
  { code: 'isl', name: 'Icelandic' },
  { code: 'ind', name: 'Indonesian' },
  { code: 'ita', name: 'Italian' },
  { code: 'jpn', name: 'Japanese' },
  { code: 'kan', name: 'Kannada' },
  { code: 'kaz', name: 'Kazakh' },
  { code: 'kor', name: 'Korean' },
  { code: 'lav', name: 'Latvian' },
  { code: 'lit', name: 'Lithuanian' },
  { code: 'mkd', name: 'Macedonian' },
  { code: 'msa', name: 'Malay' },
  { code: 'mal', name: 'Malayalam' },
  { code: 'mar', name: 'Marathi' },
  { code: 'mon', name: 'Mongolian' },
  { code: 'nep', name: 'Nepali' },
  { code: 'nor', name: 'Norwegian' },
  { code: 'nno', name: 'NorwegianNynorsk' },
  { code: 'fas', name: 'Persian' },
  { code: 'pol', name: 'Polish' },
  { code: 'por', name: 'Portuguese' },
  { code: 'pan', name: 'Punjabi' },
  { code: 'ron', name: 'Romanian' },
  { code: 'rus', name: 'Russian' },
  { code: 'srp', name: 'Serbian' },
  { code: 'sin', name: 'Sinhalese' },
  { code: 'slk', name: 'Slovak' },
  { code: 'slv', name: 'Slovenian' },
  { code: 'som', name: 'Somali' },
  { code: 'spa', name: 'Spanish' },
  { code: 'swa', name: 'Swahili' },
  { code: 'swe', name: 'Swedish' },
  { code: 'tam', name: 'Tamil' },
  { code: 'tel', name: 'Telugu' },
  { code: 'tha', name: 'Thai' },
  { code: 'bod', name: 'Tibetan' },
  { code: 'tur', name: 'Turkish' },
  { code: 'ukr', name: 'Ukrainian' },
  { code: 'urd', name: 'Urdu' },
  { code: 'vie', name: 'Vietnamese' },
] as const;

/** A stored language code. */
type DocLanguageCode = (typeof DOC_LANGUAGES)[number]['code'];

const nameByCode = new Map<string, string>(DOC_LANGUAGES.map((l) => [l.code, l.name]));

/** Codes and names, lowercased. No name is three letters long, so the two never collide. */
const codeByKey = new Map<string, DocLanguageCode>(
  DOC_LANGUAGES.flatMap((l) => [
    [l.code, l.code],
    [l.name.toLowerCase(), l.code],
  ]),
);

/** Resolve a `sourcelang:` value — a DOC language name or three-letter code, any case — to its stored code. */
export function resolveDocLanguage(value: string): DocLanguageCode | undefined {
  return codeByKey.get(value.toLowerCase());
}

/** DOC's name for a stored language code, or undefined for a code outside DOC's lookup. */
export function docLanguageName(code: string): string | undefined {
  return nameByCode.get(code);
}
