export const locales = ["zh-CN", "en-US"] as const;
export type Locale = (typeof locales)[number];
export type MessageValues = Record<string, string | number>;
export type MessageCatalog = Partial<Record<Locale, Record<string, string>>>;

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && locales.includes(value as Locale);
}

/** Plain text interpolation. Render the result as text, never as HTML. */
export function translateMessage(
  locale: Locale,
  source: string,
  catalog: MessageCatalog,
  values: MessageValues = {},
): string {
  const messages = catalog[locale];
  const translated =
    messages && Object.hasOwn(messages, source) ? messages[source] : undefined;
  const message = typeof translated === "string" ? translated : source;
  return message.replace(/\{([\w]+)\}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : match,
  );
}

export interface UIInternationalization {
  readonly locale: Locale;
  /** Plugins may supply their own catalog without importing host internals. */
  t(source: string, values?: MessageValues, catalog?: MessageCatalog): string;
  subscribe(listener: () => void): () => void;
}
