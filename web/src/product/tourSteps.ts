/*
 * The product tour, in the order a campaign day runs.
 *
 * Every image in public/tour/ comes off the demo stack (fabricated residents) and has names and
 * contact details blurred in the pixels before capture, by web/tools/tour_shots.py. Never replace
 * one with a capture of the real app: the real app is the voters list.
 */

export type TourStep = {
  /** File name in public/tour/ without the extension; a .webp and a .png are both published. */
  image: string;
  /** How the screenshot is framed, so the tour can size a phone shot like a phone. */
  frame: 'desktop' | 'phone';
  title: string;
  body: string;
  /** Describes the screenshot for someone who cannot see it. */
  alt: string;
};

export const TOUR: TourStep[] = [
  {
    image: 'map',
    frame: 'desktop',
    title: 'The whole municipality on one map',
    body:
      'The voters list is imported, matched to addresses and put on a map. Search any household by name or street, ' +
      'and see each turf drawn over the roads it covers.',
    alt: 'The CanvassOS map: households as dots over village streets, with a turf boundary outlined. Names are blurred.',
  },
  {
    image: 'turfs',
    frame: 'desktop',
    title: 'Turfs in a few clicks',
    body:
      'Pick the streets or draw a shape, and CanvassOS gathers the doors inside it. Assign a turf to a volunteer, ' +
      'and move it to someone else when plans change.',
    alt: 'The turf builder with a turf selected on the map and its door count beside it.',
  },
  {
    image: 'door',
    frame: 'phone',
    title: 'One list per volunteer, nearest door first',
    body:
      'Volunteers see only the turfs they are given. Doors come in walking order, and the list keeps working when ' +
      'the signal drops: results wait on the phone and send themselves once it is back.',
    alt: 'A phone showing a turf’s door list with results marked on several doors. Names and addresses are blurred.',
  },
  {
    image: 'record',
    frame: 'phone',
    title: 'Record the door in seconds',
    body:
      'Support, a note, a follow-up, a lawn sign request, a phone number with the purposes the resident agreed to. ' +
      'Whatever happened at the door is saved before the volunteer reaches the next one.',
    alt: 'A phone showing the record-a-visit sheet open on one door, with support level and note fields.',
  },
  {
    image: 'drive',
    frame: 'phone',
    title: 'Drive mode for rural roads',
    body:
      'On concession roads the next door is a kilometre away. Drive mode shows the next door ahead of the car, which ' +
      'side of the road it is on, and reads it aloud so the driver keeps their eyes up.',
    alt: 'A phone in drive mode: the distance to the next door in large type, then the doors after it. Addresses are blurred.',
  },
  {
    image: 'signs',
    frame: 'desktop',
    title: 'Lawn signs, from request to pickup',
    body:
      'Requests come from the door, from your website or by hand, into one delivery list with a route. Each sign ' +
      'placed gets a GPS fix and a photo, so pickup after election day is a list, not a memory.',
    alt: 'The lawn signs map: requested and placed signs along a rural road, with a count for each status.',
  },
  {
    image: 'reports',
    frame: 'desktop',
    title: 'Know where you stand',
    body:
      'Coverage and support by ward, community, turf and day, using the latest answer from each door, so you can see ' +
      'which areas still need a knock before voting opens.',
    alt: 'The coverage report: doors attempted, spoke with, supportive and follow-ups, then a table by ward with progress bars.',
  },
  {
    image: 'sheet',
    frame: 'desktop',
    title: 'Paper when you want it',
    body:
      'Every turf prints as a clean walk sheet for the volunteer who would rather carry a clipboard, or whose ' +
      'battery gave out halfway down the road.',
    alt: 'A printable turf sheet listing doors in walking order with tick boxes. Names are blurred.',
  },
];
