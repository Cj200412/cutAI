export type FirecrawlApiVersion = 'v1' | 'v2';

export function firecrawlApiBase(
  configuredBaseUrl: string | null | undefined,
  version: FirecrawlApiVersion,
): string {
  const configured = (configuredBaseUrl ?? '').trim().replace(/\/+$/, '');
  if (!configured) return `https://api.firecrawl.dev/${version}`;
  if (/\/v[12]$/i.test(configured)) return configured.replace(/\/v[12]$/i, `/${version}`);
  return `${configured}/${version}`;
}

export function firecrawlRoot(configuredBaseUrl: string | null | undefined): string {
  return (configuredBaseUrl ?? '').trim().replace(/\/+$/, '').replace(/\/v[12]$/i, '');
}
