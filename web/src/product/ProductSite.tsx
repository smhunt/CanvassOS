import '@fontsource-variable/overpass/wght.css';
import './product.css';
import { useRef, type RefObject } from 'react';
import { Wordmark } from '../components/Shell';
import { goToWaitlist } from './goToWaitlist';
import { SENDER } from './waitlist';
import { TurfHero } from './TurfHero';
import { WaitlistForm } from './WaitlistForm';

type Props = {
  onSignIn: () => void;
  onTour: () => void;
  /** Filled with the waitlist's first field, so the tour's last step can send people there. */
  waitlistField?: RefObject<HTMLInputElement>;
};

/*
 * The public product page. It is what a signed-out visitor sees behind the sign-in dialog: no
 * campaign data, no API calls except the waitlist form, so showing it before sign-in discloses
 * nothing from the voters list.
 */
export function ProductSite({ onSignIn, onTour, waitlistField }: Props) {
  const localField = useRef<HTMLInputElement>(null);
  const field = waitlistField ?? localField;

  const toWaitlist = () => goToWaitlist(field);

  return (
    <div className="product">
      <header className="product__bar">
        <Wordmark />
        <nav className="product__nav" aria-label="Product">
          <button type="button" className="p-link" onClick={onTour}>
            Take the tour
          </button>
          <button type="button" className="p-link" onClick={toWaitlist}>
            Waitlist
          </button>
          <button type="button" className="p-btn p-btn--ink p-btn--small" onClick={onSignIn}>
            Sign in
          </button>
        </nav>
      </header>

      <main>
        <section className="hero">
          <div className="hero__copy">
            <h1>Every door in your municipality, on a map your volunteers can carry.</h1>
            <p className="hero__lede">
              CanvassOS is the canvassing system built for an Ontario municipal campaign and used on its doors every
              day: the voters list on a map, a turf for each volunteer, a door screen that keeps working without signal,
              and lawn signs tracked from request to pickup.
            </p>
            <div className="hero__actions">
              <button type="button" className="p-btn p-btn--sign" onClick={toWaitlist}>
                Join the waitlist
              </button>
              <button type="button" className="p-btn p-btn--quiet" onClick={onTour}>
                Take the tour
              </button>
            </div>
            <p className="hero__aside">Opening to a few more campaigns. The waitlist hears first.</p>
          </div>
          <div className="hero__map">
            <TurfHero />
            <ul className="legend" aria-label="Map key">
              <li>
                <span className="legend__swatch legend__swatch--knocked" /> Knocked
              </li>
              <li>
                <span className="legend__swatch legend__swatch--support" /> Supporter
              </li>
              <li>
                <span className="legend__swatch legend__swatch--sign" /> Lawn sign
              </li>
            </ul>
          </div>
        </section>

        <section className="day" aria-labelledby="day-title">
          <h2 id="day-title">Built around a canvassing day</h2>
          <div className="day__cols">
            <div className="day__col">
              <h3>Before you knock</h3>
              <dl>
                <dt>Your list, mapped</dt>
                <dd>The voters list imported, matched to addresses and searchable by name or street.</dd>
                <dt>Turfs in minutes</dt>
                <dd>Pick the streets or draw a shape. Assign it to a volunteer, and move it when plans change.</dd>
                <dt>Paper too</dt>
                <dd>Every turf prints as a walk sheet for the volunteer who prefers a clipboard.</dd>
              </dl>
            </div>
            <div className="day__col">
              <h3>At the door</h3>
              <dl>
                <dt>Nearest door first</dt>
                <dd>Each volunteer sees only their own turfs, in walking order, on a phone or tablet.</dd>
                <dt>No signal, no problem</dt>
                <dd>Results wait on the phone and send themselves once the signal is back.</dd>
                <dt>Seconds per door</dt>
                <dd>Support, a note, a follow-up, a sign request, and contact details with the purposes agreed to.</dd>
              </dl>
            </div>
            <div className="day__col">
              <h3>After the door</h3>
              <dl>
                <dt>Follow-ups that happen</dt>
                <dd>A door that needs a call back goes into the follow-up queue, so nobody forgets it.</dd>
                <dt>Lawn signs, start to finish</dt>
                <dd>
                  Requests from the door, your website or by hand, a delivery route, and a GPS fix and photo of every
                  sign.
                </dd>
                <dt>Where you stand</dt>
                <dd>Coverage and support by ward, community, turf and day.</dd>
              </dl>
            </div>
          </div>
        </section>

        <section className="rural" aria-labelledby="rural-title">
          <div className="rural__sign" aria-hidden="true">
            <span>Next door</span>
            <strong>650 m</strong>
            <span>on your right</span>
          </div>
          <div className="rural__copy">
            <h2 id="rural-title">Concession roads, not city blocks</h2>
            <p>
              Most canvassing tools assume a neighbourhood you can walk. In a rural township the next door is down a
              laneway half a kilometre on. Drive mode shows the next door ahead of the car, which side of the road it is
              on, and says it out loud, so whoever is driving keeps their eyes on the road.
            </p>
          </div>
        </section>

        <section className="rules" aria-labelledby="rules-title">
          <h2 id="rules-title">Your voters list is personal information. CanvassOS treats it that way.</h2>
          <p className="rules__lede">
            Ontario's <em>Municipal Elections Act</em> lets a campaign use the voters list for election purposes only.
            CanvassOS is built so that rule holds even with dozens of volunteers.
          </p>
          <ul className="rules__list">
            <li>Sign-in on every page. Accounts are by invitation.</li>
            <li>Volunteers see only the doors in their own turfs, and none of the mailing details.</li>
            <li>Every look-up of personal information is written to an audit log.</li>
            <li>Encrypted backups, and one command that erases the list after election day.</li>
            <li>Texts and emails only to people who opted in, with STOP honoured at once.</li>
            <li>The list lives on a server your campaign controls.</li>
          </ul>
        </section>

        <section className="waitlist" id="waitlist" aria-labelledby="waitlist-title">
          <div className="waitlist__intro">
            <h2 id="waitlist-title">Join the waitlist</h2>
            <p>
              CanvassOS runs one campaign today. We're opening it to a small number of others, starting with Ontario
              municipal campaigns. Tell us about yours and we'll be in touch.
            </p>
            <dl className="faq">
              <dt>What does it cost?</dt>
              <dd>Pricing isn't set yet. Campaigns on the waitlist hear first.</dd>
              <dt>We're not in Ontario.</dt>
              <dd>
                It's built around Ontario's voters list and election rules. Sign up anyway and tell us where you are.
              </dd>
              <dt>Do volunteers install an app?</dt>
              <dd>No. It runs in the phone's browser and can be added to the home screen.</dd>
            </dl>
          </div>
          <WaitlistForm ref={field} />
        </section>
      </main>

      <footer className="product__foot">
        <p>
          Built for, and used every day on, a 2026 mayoral campaign in Middlesex Centre, Ontario. Made by {SENDER.name}:{' '}
          <a href={`mailto:${SENDER.email}`}>{SENDER.email}</a>
        </p>
        <button type="button" className="p-link" onClick={onSignIn}>
          Volunteer or organiser? Sign in
        </button>
      </footer>
    </div>
  );
}
