export type TmdbLanguage = 'en-US' | 'ar-SA';

export const DEFAULT_TMDB_LANGUAGE: TmdbLanguage = 'en-US';

export function normalizeTmdbLanguage(value?: string | null): TmdbLanguage {
  const normalized = (value || '').trim().toLowerCase();
  if (normalized === 'ar' || normalized.startsWith('ar-')) {
    return 'ar-SA';
  }
  return DEFAULT_TMDB_LANGUAGE;
}

export function getTmdbImageLanguage(language?: string | null): string {
  const normalized = normalizeTmdbLanguage(language);
  if (normalized === 'ar-SA') return 'ar,en,null';
  return 'en,null';
}

export function getStableTmdbImageLanguage(): string {
  return 'en,null';
}

export function getTmdbVideoLanguage(language?: string | null): string {
  const normalized = normalizeTmdbLanguage(language);
  if (normalized === 'ar-SA') return 'ar,en,null';
  return 'en,null';
}

export function appendTmdbLanguageParam(
  params: URLSearchParams,
  language?: string | null,
): URLSearchParams {
  params.set('tmdbLanguage', normalizeTmdbLanguage(language));
  return params;
}
