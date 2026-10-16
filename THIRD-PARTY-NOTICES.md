# Third-party attribution

This project is a thin desktop shell that references a separately installed
DSH. Portions of its structure and logic are adapted from MIT-licensed upstream
sources; the original copyright notices are reproduced below, and the
corresponding files carry an in-file attribution header.

Both upstream projects are distributed under the MIT License, whose terms are
reproduced in full in [LICENSE](LICENSE).

## deepseek-ai/deepseek-harness

Source: https://github.com/deepseek-ai/deepseek-harness

Adapted files (structure and logic):

- `src/main/web-document.ts` — adapted from `apps/desktop/src/web-document.ts`
- `src/main/host-process.ts` — adapted from `apps/desktop/src/host-process.ts`
- `src/preload/app.ts` — structure follows `apps/desktop/src/preload-app.ts`
- the WebSocket handshake header rewrite in `src/main/main.ts` — same recipe as
  `apps/desktop/src/main.ts`

## anywhere-labs/dsh-desktop

Source: https://github.com/anywhere-labs/dsh-desktop

Adapted files (structure and logic):

- `src/host/platform-login.ts` — adapted from
  `dsh-desktop-next/src/host/platform-login.ts`
- `src/preload/keyboard.ts` — structure follows
  `dsh-desktop-next/src/preload-keyboard.ts`
