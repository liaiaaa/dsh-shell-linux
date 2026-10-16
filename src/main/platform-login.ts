/** Shell side of Platform sign-in: open the authorization page, settle the window afterwards. */

export function platformLoginUrl(authorizeUrl: string, dark: boolean): string {
  const url = new URL(authorizeUrl)
  url.searchParams.set('theme', dark ? 'dark' : 'light')
  return url.href
}
