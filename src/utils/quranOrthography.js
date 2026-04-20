import { getArabicWordVariants } from './arabicNormalize.js';

const SHADDA_RE = /\u0651/gu;
const DAGGER_ALEF_RE = /\u0670/gu;
const MADDAH_RE = /\u0653/gu;
const HARAKAT_RE = /[\u064B-\u0652]/gu;
const FATHA_RE = /\u064E/gu;
const DAMMA_RE = /\u064F/gu;
const KASRA_RE = /\u0650/gu;
const SUKUN_RE = /\u0652/gu;
const TANWEEN_RE = /[\u064B-\u064D]/gu;
const TATWEEL_RE = /\u0640/gu;
const SMALL_WAW_RE = /\u06E5/gu;
const SMALL_YA_RE = /\u06E6/gu;

function countMatches(text, re) {
  if (!text) return 0;
  const matches = String(text).match(re);
  return matches ? matches.length : 0;
}

export function extractQuranOrthographyFeatures(text) {
  const value = String(text ?? '');

  return {
    hasShadda: SHADDA_RE.test(value),
    shaddaCount: countMatches(value, SHADDA_RE),
    hasDaggerAlef: DAGGER_ALEF_RE.test(value),
    daggerAlefCount: countMatches(value, DAGGER_ALEF_RE),
    hasMaddah: MADDAH_RE.test(value),
    maddahCount: countMatches(value, MADDAH_RE),
    harakatCount: countMatches(value, HARAKAT_RE),
    fathaCount: countMatches(value, FATHA_RE),
    dammaCount: countMatches(value, DAMMA_RE),
    kasraCount: countMatches(value, KASRA_RE),
    sukunCount: countMatches(value, SUKUN_RE),
    tanweenCount: countMatches(value, TANWEEN_RE),
  };
}

export function expandQuranOrthographyVariants(text) {
  const value = String(text ?? '').trim();
  if (!value) return [];

  const variants = new Set([value]);

  // Uthmani often encodes long vowels as a dagger alef, sometimes preceded by tatweel.
  variants.add(value.replace(new RegExp(`${TATWEEL_RE.source}?${DAGGER_ALEF_RE.source}`, 'gu'), 'ا'));

  // Some mushaf encodings use small waw/ya marks that are pronounced as long vowels.
  variants.add(value.replace(SMALL_WAW_RE, 'و'));
  variants.add(value.replace(SMALL_YA_RE, 'ي'));
  variants.add(
    value
      .replace(SMALL_WAW_RE, 'و')
      .replace(SMALL_YA_RE, 'ي'),
  );

  // Remove tatweel; it is purely visual and can interfere with downstream tokenization.
  variants.add(value.replace(TATWEEL_RE, ''));

  return Array.from(variants).filter(Boolean);
}

export function mergeQuranVariants({
  tokenText,
  uthmaniText,
  indopakText,
  simpleTokens,
  limit = 96,
} = {}) {
  const sources = [];

  if (tokenText) sources.push(tokenText);
  if (uthmaniText) sources.push(uthmaniText);
  if (indopakText) sources.push(indopakText);
  if (Array.isArray(simpleTokens)) {
    for (const token of simpleTokens) {
      if (token) sources.push(token);
    }
  }

  const variants = new Set();

  for (const source of sources) {
    for (const variant of getArabicWordVariants(source)) {
      variants.add(variant);
      if (variants.size >= limit) {
        return Array.from(variants);
      }
    }

    // Add Quran-specific orthography expansions (dagger alef, small waw/ya, tatweel).
    for (const expanded of expandQuranOrthographyVariants(source)) {
      for (const variant of getArabicWordVariants(expanded)) {
        variants.add(variant);
        if (variants.size >= limit) {
          return Array.from(variants);
        }
      }
    }
  }

  return Array.from(variants);
}

