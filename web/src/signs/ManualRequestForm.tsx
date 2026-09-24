/**
 * Type in a sign request that arrived by phone, text, Facebook or across a table at the fair.
 *
 * Most requests do not come from a canvasser's tablet, and before this screen existed they lived on
 * the back of an envelope. The form is deliberately short — a name, some way to reach them, and
 * roughly where — because it is filled in one-handed, often while still on the call.
 *
 * The address box doubles as a household search. Picking a real door links the request to the
 * voters list, which is what lets the sign be placed against that household later; typing a farm
 * gate or a rural route and picking nothing is equally valid, and common. Nothing is required to be
 * on the list, because plenty of people who want a sign are not a door the clerk's file knows about.
 *
 * Used for editing too: pass `editing` and it arrives filled in, saves with PATCH, and says so.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useCreateManualRequest, useSearch, useUpdateManualRequest } from '../api/hooks';
import type { PublicRequest } from '../api/types';
import { ErrorBox, Spinner } from '../components/ui';

interface Props {
  /** The row being corrected, or null to take a new request. */
  editing?: PublicRequest | null;
  onDone: () => void;
  onCancel: () => void;
}

interface Picked {
  id: string;
  address: string;
}

const EMPTY = { name: '', phone: '', email: '', address: '', note: '' };

export function ManualRequestForm({ editing = null, onDone, onCancel }: Props) {
  const create = useCreateManualRequest();
  const update = useUpdateManualRequest();
  const save = editing ? update : create;

  const [form, setForm] = useState(() =>
    editing
      ? {
          name: editing.name,
          phone: editing.phone ?? '',
          email: editing.email ?? '',
          address: editing.address ?? '',
          note: editing.note ?? '',
        }
      : EMPTY,
  );
  // The door this request is linked to, when one was picked. An edit arrives already linked, but
  // the address it was linked by is not on the row, so it shows as "linked to a door" until the
  // organiser searches again — honest, and better than inventing an address to display.
  const [picked, setPicked] = useState<Picked | null>(
    editing?.household_id ? { id: editing.household_id, address: editing.address ?? 'a door on the list' } : null,
  );
  const [searching, setSearching] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  // Opening the form should put the cursor in it: this is a live phone call.
  useEffect(() => nameRef.current?.focus(), []);

  const field = (k: keyof typeof EMPTY) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  // Searched only while the organiser is actually looking, and only once the term is worth a query.
  const term = form.address.trim();
  const hits = useSearch(term, searching && !picked);

  const reachable = form.phone.trim() !== '' || form.email.trim() !== '' || form.address.trim() !== '';

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || !reachable) return;
    const body = {
      name: form.name.trim(),
      phone: form.phone.trim() || null,
      email: form.email.trim() || null,
      address: form.address.trim() || null,
      note: form.note.trim() || null,
      wants: ['sign'],
      household_id: picked?.id ?? null,
    };
    if (editing) {
      update.mutate({ requestId: editing.id, ...body }, { onSuccess: () => onDone() });
    } else {
      create.mutate(body, { onSuccess: () => onDone() });
    }
  }

  return (
    <form className="card sg-manual" onSubmit={submit} aria-label={editing ? 'Edit this request' : 'Add a sign request'}>
      <h3 className="sheet__h3">{editing ? 'Edit this request' : 'New sign request'}</h3>

      <div className="field">
        <label className="field__label" htmlFor="mr-name">
          Name
        </label>
        <input
          id="mr-name"
          ref={nameRef}
          type="text"
          maxLength={200}
          required
          value={form.name}
          onChange={(e) => field('name')(e.target.value)}
          autoComplete="off"
        />
      </div>

      <div className="sg-manual__pair">
        <div className="field">
          <label className="field__label" htmlFor="mr-phone">
            Phone
          </label>
          <input
            id="mr-phone"
            type="tel"
            maxLength={40}
            value={form.phone}
            onChange={(e) => field('phone')(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="mr-email">
            Email
          </label>
          <input
            id="mr-email"
            type="email"
            maxLength={200}
            value={form.email}
            onChange={(e) => field('email')(e.target.value)}
            autoComplete="off"
          />
        </div>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="mr-address">
          Where the sign goes
        </label>
        {picked ? (
          <div className="sg-door">
            <div>
              <span className="field__label">Linked to this door</span>
              <p className="sg-door__addr">{picked.address}</p>
            </div>
            <button
              type="button"
              className="btn btn--small"
              onClick={() => {
                setPicked(null);
                setSearching(true);
              }}
            >
              Change
            </button>
          </div>
        ) : (
          <>
            <input
              id="mr-address"
              type="text"
              maxLength={300}
              value={form.address}
              onChange={(e) => {
                field('address')(e.target.value);
                setSearching(true);
              }}
              placeholder="123 King St, or the farm gate on Vanneck"
              aria-describedby="mr-address-hint"
              autoComplete="off"
            />
            <p className="field__hint" id="mr-address-hint">
              Start typing and pick the door from the list to link it to the voters list. Typing it freehand is fine
              too — plenty of places that want a sign are not a door on the list.
            </p>
          </>
        )}

        {!picked && searching && term.length >= 2 && (
          <div className="sg-manual__hits" role="listbox" aria-label="Matching doors">
            {hits.isFetching && (
              <p className="muted small">
                <Spinner size={14} /> Looking…
              </p>
            )}
            {hits.data?.households.slice(0, 6).map((h) => (
              <button
                key={h.id}
                type="button"
                role="option"
                aria-selected={false}
                className="sg-manual__hit"
                onClick={() => {
                  setPicked({ id: h.id, address: h.address });
                  field('address')(h.address);
                  setSearching(false);
                }}
              >
                {h.address}
              </button>
            ))}
            {!hits.isFetching && hits.data?.households.length === 0 && (
              <p className="muted small">No door on the list matches that. Leave it as typed.</p>
            )}
          </div>
        )}
      </div>

      <div className="field">
        <label className="field__label" htmlFor="mr-note">
          Note
        </label>
        <textarea
          id="mr-note"
          className="sg-textarea"
          maxLength={2000}
          rows={2}
          value={form.note}
          onChange={(e) => field('note')(e.target.value)}
          placeholder="Wants it by the weekend · corner lot, put it on the side street"
        />
      </div>

      {save.isError && <ErrorBox title="Not saved" error={save.error} compact />}

      {!reachable && form.name.trim() !== '' && (
        <p className="field__hint sg-manual__need">
          Give a phone number, an email or an address — a request with no way to find them cannot be delivered.
        </p>
      )}

      <div className="sg-manual__actions">
        <button type="submit" className="btn btn--primary" disabled={save.isPending || !form.name.trim() || !reachable}>
          {save.isPending ? (
            <>
              <Spinner size={16} /> Saving…
            </>
          ) : editing ? (
            'Save changes'
          ) : (
            'Add the request'
          )}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={save.isPending}>
          Cancel
        </button>
      </div>
      {!editing && (
        <p className="muted small sg-manual__consent">
          Recorded as asked by phone, text or in person, in your name and today's date. It also appears in Sign-ups,
          where the app will suggest which voter on the list they are.
        </p>
      )}
    </form>
  );
}
