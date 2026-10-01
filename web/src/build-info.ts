/*
 * What this bundle was built from. vite.config.ts defines `__BUILD__` at build time (commit from
 * the GIT_COMMIT build arg or git itself, and the time); the tests run under tsx with no Vite, so
 * the guard below keeps them importing this file without a ReferenceError.
 */
declare global {
  // eslint-disable-next-line no-var
  var __BUILD__: { commit: string; builtAt: string } | undefined;
}

export interface WebBuild {
  commit: string;
  /** ISO 8601, or '' when unknown. */
  builtAt: string;
}

export const WEB_BUILD: WebBuild =
  typeof __BUILD__ !== 'undefined' && __BUILD__ ? __BUILD__ : { commit: 'unknown', builtAt: '' };
