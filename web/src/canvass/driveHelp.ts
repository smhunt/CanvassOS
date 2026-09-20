import type { HelpTopic } from '../components/HelpButton';

/**
 * What drive mode says about itself: read aloud the first time Start is tapped, and again from the
 * question mark on the drive bar. Fixed text, written in advance — nothing here is, or may ever be,
 * built from a door (see the rule at the top of src/speech.ts).
 *
 * `spoken` is a script, not the on-screen text read out: short sentences a driver can take in by
 * ear, about twenty seconds in all, and no figure that a synthesiser would stumble over. One array
 * entry per sentence, because explain() queues them as separate utterances.
 */
export const DRIVE_HELP: HelpTopic = {
  title: 'How drive mode works',
  spoken: [
    'This is drive mode.',
    'The large card shows the next door ahead of you, how far away it is, and which side of the road it is on.',
    'It moves on by itself as you pass, and I will read each door out, so you never need to touch the phone.',
    'I never say a name out loud.',
    'Keep the phone in its mount while you are moving.',
    'When you are parked, tap the question mark to hear this again.',
  ],
  sections: [
    {
      heading: 'The card',
      body: 'The next door ahead of you — not the nearest one, which on a concession road is often the door you have just passed. It shows the distance, the address and which side of the road. It changes by itself as you drive past.',
    },
    {
      heading: '"Pointing unknown — showing nearest first"',
      body: 'A phone only knows which way it is heading while it is moving. Parked, or stopped at a sign, it falls back to the nearest door and says nothing. It sorts itself out within a few seconds of setting off.',
    },
    {
      heading: 'Speech',
      body: 'Reads each new door aloud: the distance and the side of the road, never a name. Turn it off if a passenger is reading the screen to you.',
    },
    {
      heading: 'Names',
      body: 'Shows or hides the electors’ names on the card. This only affects the screen — names are never spoken, whichever way it is set.',
    },
    {
      heading: 'The list under the card',
      body: 'The doors that come after this one, in the order you will reach them.',
    },
    {
      heading: 'Recording a result',
      body: 'Pull over and stop, then tap "Back to the list" and record the door as usual. It works with no signal: the result waits on the phone and sends itself later, and the door is not offered to you again.',
    },
    {
      heading: 'While the car is moving',
      body: 'Do not touch the phone — in Ontario it is an offence, and this screen is built so that you never have to. Open this help only when you are parked.',
    },
  ],
};
