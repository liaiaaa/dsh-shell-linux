/**
 * Mask credentials in log text.
 *
 * The host prints its authenticated URL — `http://127.0.0.1:<port>/?token=…` — on boot and the
 * shell forwards everything it prints to the journal; the About window shows npm output the same
 * way. Project red line 3: a log line is masked wherever it is forwarded or displayed, so this one
 * helper serves both the host stdout forwarder and the upgrade log.
 */
const TOKEN_PATTERN = /([?&]token=)[^\s&"']+/g

/** Replace the value of any `?token=` / `&token=` query parameter with `<redacted>`. */
export function redactTokens(text: string): string {
  return text.replace(TOKEN_PATTERN, '$1<redacted>')
}
