import { useState } from 'react';
import { useMeta } from '../api/hooks';
import { WEB_BUILD } from '../build-info';
import { APP_VERSION, ChangelogModal, type AboutTab } from './changelog-modal';

const ENV_LABEL = { production: 'Production', demo: 'Demo (invented data)', development: 'Development' } as const;

const whenText = (iso: string) =>
  iso && !Number.isNaN(Date.parse(iso))
    ? new Intl.DateTimeFormat('en-CA', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Toronto' }).format(
        new Date(iso),
      )
    : null;

/*
 * The line at the foot of every signed-in screen that says what is running: the version, which
 * environment this is, the host, the commit the web and the API were each built from, and when.
 * Tapping the version opens the same Changelog / How it works / Roadmap notes as Account. The
 * API's half comes from /api/meta, which every screen already loads; until it arrives the line
 * shows the web's half alone rather than nothing.
 */
export function BuildLine() {
  const meta = useMeta();
  const [about, setAbout] = useState<AboutTab | null>(null);
  const api = meta.data?.build;
  const web = WEB_BUILD.commit;
  const known = (c: string | undefined) => !!c && c !== 'unknown';
  const mismatch = known(web) && known(api?.commit) && web !== api?.commit;
  const built = whenText(api?.built_at ?? WEB_BUILD.builtAt);

  return (
    <div className="build" data-env={api?.env}>
      <button type="button" className="build__version mono" onClick={() => setAbout('changelog')}>
        CanvassOS v{APP_VERSION}
      </button>
      {api && <span className={`build__env build__env--${api.env}`}>{ENV_LABEL[api.env] ?? api.env}</span>}
      <span className="mono">{window.location.host}</span>
      <span className="mono" title="The commit this web app was built from">
        web {web}
      </span>
      {api && (
        <span className="mono" title="The commit the API was built from">
          api {api.commit}
        </span>
      )}
      {api && api.version !== APP_VERSION && (
        <span className="build__warn">API is v{api.version}: web and API versions differ</span>
      )}
      {mismatch && <span className="build__warn">web and API are from different commits</span>}
      {built && <span>built {built}</span>}
      <span className="build__links">
        <button type="button" className="build__link" onClick={() => setAbout('changelog')}>
          Changelog
        </button>
        <button type="button" className="build__link" onClick={() => setAbout('how')}>
          How it works
        </button>
        <button type="button" className="build__link" onClick={() => setAbout('roadmap')}>
          Roadmap
        </button>
      </span>
      <ChangelogModal
        open={about !== null}
        tab={about ?? 'changelog'}
        onTab={setAbout}
        onClose={() => setAbout(null)}
      />
    </div>
  );
}
