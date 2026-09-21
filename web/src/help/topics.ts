import type { HelpTopic } from '../components/HelpButton';

/**
 * One help topic per screen. Fixed text, written in advance — nothing here is, or may ever be,
 * built from a door, a voter or a record (see the rule at the top of src/speech.ts). `spoken` is a
 * short script for the ear, one sentence per entry and no figures; `sections` is what the dialog
 * shows.
 */

export const MAP_HELP: HelpTopic = {
  title: 'How the map works',
  spoken: [
    'This is the map of every household on the voters list.',
    'Each dot is a door, and the menu beside the filters changes what the colours mean.',
    'Tap a dot to open its card, and use Boundaries to see where the turfs are.',
    'Organizers can also search, draw a new turf, and record a visit straight from a card.',
    'Please never copy, photograph or share what you see here, because the voters list is protected by law.',
  ],
  sections: [
    {
      heading: 'Dots and colours',
      body: 'Every dot is one door. The menu next to Filters chooses what the colour means: Ward, Community, Voters per door or Canvass status, and organizers also get Record quality and Non-resident owners. “Legend” at the bottom left explains the colours and can be folded away.',
    },
    {
      heading: 'Filters and counts',
      body: 'Filters narrows the map to chosen wards and communities (organizers can also filter by record quality). The pill at the bottom left counts the doors and voters in view, and how many match your filters.',
    },
    {
      heading: 'Tapping a door',
      body: 'Volunteers see how many voters live at that door and nothing more; names are on the door screen for your own turfs. Organizers see the names, the record details, mailing addresses, and buttons to “Record a visit”, “Open in the door screen”, “Place a lawn sign” and get “Directions”.',
    },
    {
      heading: 'Boundaries',
      body: 'Boundaries draws turf outlines on the map (a volunteer sees only their own turfs). A dotted outline is approximate: it was drawn around a turf built from streets, so it may cover doors that are not in it. Tap an outline to highlight that turf’s doors, then press Clear to go back.',
    },
    {
      heading: 'Base layer',
      body: 'The layers button switches the background between Streets and Satellite. “Light” only works if the campaign has set up a CARTO key. Your choice is remembered on this device.',
    },
    {
      heading: 'Organizers: search and draw',
      body: 'The magnifying glass searches voters and addresses and flies to the door. “Draw turf” lets you tap corners on the map to outline a new turf, then Finish, name it and “Create turf”. Every door inside the shape is included, even if filters are hiding some of them.',
    },
    {
      heading: 'Unmapped parcels',
      body: 'Some doors on the list have a legal description instead of a street address, so they have no dot. Organizers can open the list of them from the “Unmapped parcels” link at the bottom of the legend.',
    },
    {
      heading: 'Keep it private',
      body: 'The voters list is personal information under Ontario’s Municipal Elections Act. Every card an organizer opens is recorded in the audit log, so please do not screenshot, copy or share it.',
    },
  ],
};

export const CANVASS_HELP: HelpTopic = {
  title: 'How the canvass page works',
  spoken: [
    'This page lists the turfs assigned to you.',
    'Each card shows how many doors it has and how many you have reached so far.',
    'Tap a turf to open its door screen and start knocking.',
    'If you only have one turf, the app opens it for you and skips this list.',
    'The little pill at the top tells you whether your results have reached the campaign.',
  ],
  sections: [
    {
      heading: 'Your turfs',
      body: 'Each card shows the turf’s name, its ward, how many doors it has, any due date, and a progress bar. The chip reads Open, In progress or Done.',
    },
    {
      heading: 'Why you might not see this list',
      body: 'If you have only one turf, or this phone was last working in one, the app skips straight to its door screen. To get back here, tap the Turfs button at the top of the door screen and choose “All my turfs”.',
    },
    {
      heading: 'No turfs yet',
      body: 'An organizer has to assign you a turf before anything appears. Once they have, reload the page and it will show up.',
    },
    {
      heading: 'The sync pill',
      body: 'The pill at the top right says Synced when everything you recorded has reached the server. Tap it any time to see what is still waiting on this phone.',
    },
    {
      heading: 'Saved on this phone',
      body: 'If the list cannot load because there is no signal, any turf you have opened before is shown under “Saved on this phone”, so you can keep working.',
    },
  ],
};

export const DOOR_HELP: HelpTopic = {
  title: 'How the door screen works',
  spoken: [
    'This is the door screen for one turf.',
    'Tap a door to see who is on the list there, then tap what happened.',
    'When you save, the next door you have not knocked opens by itself.',
    'If you have no signal, your results wait safely on the phone and send themselves later.',
    'On long rural roads, the Drive button gives you a hands free mode for the car.',
    'Please do not photograph or share the names on this screen.',
  ],
  sections: [
    {
      heading: 'Finding the next door',
      body: '“All doors” shows the whole turf and “Not yet knocked” hides the ones already done. “Near me” sorts by distance from where you are standing; it needs location turned on, and the doors stay in walking order until the phone has a fix. Map shows the turf as dots instead of a list.',
    },
    {
      heading: 'At the door',
      body: 'A door shows the names on the list, any previous visits, and “Walk here”, which opens your phone’s own map app. Use “‹ Previous door” and “Next door ›” to move along the walking order.',
    },
    {
      heading: 'Recording what happened',
      body: 'Tap one result: Spoke, Not home, Left literature, Refused, Moved, Inaccessible, Do not knock or Deceased. Every result except Spoke saves at once, and the next door you have not knocked opens automatically.',
    },
    {
      heading: 'When you spoke to someone',
      body: 'Spoke opens a short form, and everything in it is optional. Pick who you spoke to (or leave it on “Whole door”), their support from 1 to 5, and any asks: a lawn sign, volunteering, a ride to vote or a follow-up. Then tap “Save — spoke”.',
    },
    {
      heading: 'Phone numbers and email',
      body: '“+ Add a phone or email” in the Spoke form records contact details only with consent. Tick only what the person actually agreed to out loud, a vote reminder or campaign updates, because it is kept as the campaign’s legal record.',
    },
    {
      heading: 'No signal? Keep going',
      body: 'Results recorded with no signal wait on the phone and send themselves as soon as there is a connection. The pill reads “Synced”, “3 to sync”, “Offline · 3 saved here” or “needs attention”; tap it for details and a button to sync now. A red “The server would not accept this” box means the server refused it, not the signal.',
    },
    {
      heading: 'Drive mode for rural roads',
      body: 'On concession roads where doors are far apart, tap Drive. It shows the next door ahead, reads distances aloud, and never needs you to touch the phone while moving. Pull over to record results.',
    },
    {
      heading: 'Your other turfs and paper',
      body: 'The Turfs button at the top lists your other turfs, with a “Print sheet” link for each if you would rather walk with paper. “Clear saved turf data” in the sync pill removes the doors and names stored on this phone.',
    },
  ],
};

export const TURFS_HELP: HelpTopic = {
  title: 'How the turfs page works',
  spoken: [
    'A turf is a bundle of streets that one person can walk.',
    'Use New turf to build one by picking streets, then assign it to a volunteer.',
    'Volunteers only ever see the doors in the turfs assigned to them.',
    'To draw a turf as a shape instead, use Draw turf on the map.',
    'Each card also lets you move a volunteer, print a paper sheet, rename or archive the turf.',
  ],
  sections: [
    {
      heading: 'Building a turf from streets',
      body: '“New turf” opens a street picker. Name it, optionally choose a ward, search or filter by community, and tick streets; the totals add up as you go, and a map shows the shape. Up to about 150 doors is marked “a walkable turf”; past 300 it suggests splitting.',
    },
    {
      heading: 'Watch for overlaps',
      body: 'Tick “Hide streets already in a turf” to avoid doubling up. A street marked with a warning runs through more than one ward, and picking it takes in every ward it touches.',
    },
    {
      heading: 'Drawing a turf instead',
      body: 'For rural areas it is often easier to draw. Go to the Map, tap “Draw turf”, tap the corners, then Finish and “Create turf”. Every door inside the shape is included.',
    },
    {
      heading: 'Assigning volunteers',
      body: 'After you create a turf the assign dialog opens by itself. “Assign” (or “Assign another”) adds a person, and a turf can have more than one. Move and Remove sit beside each name.',
    },
    {
      heading: 'If a move only half happens',
      body: 'Moving a turf adds the new person first, then removes the old one. If the second step fails you will see “The move only half happened”, and you can remove the extra person with one tap.',
    },
    {
      heading: 'Other buttons on a card',
      body: '“Show on map” highlights the turf’s doors on the map. “Print sheet” opens a paper walk list. Rename changes the name, and Archive hides the turf from this list; tick “Show archived” to find it again and Unarchive it.',
    },
    {
      heading: 'The tiles at the top',
      body: 'They count active turfs, doors in turfs, doors contacted, and turfs still waiting on a volunteer.',
    },
  ],
};

export const SIGNS_HELP: HelpTopic = {
  title: 'How the lawn signs screen works',
  spoken: [
    'This screen keeps track of every lawn sign.',
    'Stand at the sign, get a location fix, fill in a label, and save it.',
    'Then take a photo of the sign next to something permanent, like a gate or a pole.',
    'The fix and the photo are how the crew finds every sign again after the election.',
    'It all works with no signal, and uploads itself later.',
  ],
  sections: [
    {
      heading: 'Place a sign',
      body: 'Stand at the sign and tap “Get GPS fix”. A sign cannot be saved without a fix, so step outdoors and away from trees if it is slow. Then fill in the Label, Size, “Permission from” and Note, and tap “Save this sign”.',
    },
    {
      heading: 'Write a good label',
      body: 'The Label is how the pickup crew will recognise the spot, so write it even when the fix is good. “Permission from” is the name of whoever said yes, so a complaint later can be answered.',
    },
    {
      heading: 'The photo',
      body: 'After saving, add a photo that frames the sign and something permanent beside it: the gate, the hydro pole, the culvert. Large photos are shrunk on the phone before sending.',
    },
    {
      heading: 'No signal',
      body: 'A sign saved offline shows “Saved on this phone” and goes up on its own when there is signal, and so does its photo. “Clear saved turf data” in the sync panel deletes any photo still waiting, so send it first.',
    },
    {
      heading: 'Sign requests',
      body: 'Doors where a canvasser ticked “Wants a lawn sign”. Tap “Place a sign here” to record the delivery against that door, and it drops off the list. Volunteers see only requests in their own turfs.',
    },
    {
      heading: 'Map and pickup list',
      body: 'Map shows signs as Requested, Placed, Missing or damaged, and Removed; tap a type to show or hide it. The Pickup list is every sign still standing, with Directions and a “Picked up” button, and can be filtered by ward.',
    },
  ],
};

export const REQUESTS_HELP: HelpTopic = {
  title: 'How the sign-ups screen works',
  spoken: [
    'This is where people who signed up on the campaign website land.',
    'Each card shows what they asked for, like a lawn sign, volunteering or voting reminders.',
    'The app suggests which voter on the list they might be, and you confirm or reject each guess.',
    'Mark a card handled once someone has followed up.',
  ],
  sections: [
    {
      heading: 'What you see',
      body: 'Each card shows the person’s name, the date, whether it came from the website or the public form, their contact details and what they want. New website sign-ups appear within five minutes.',
    },
    {
      heading: 'Matching to the voters list',
      body: 'Under “Is this one of these people” the app lists its best guesses, with how each was matched. Tap “That’s them” to link the sign-up, or “Not them” so that guess never comes back.',
    },
    {
      heading: 'Undoing a match',
      body: 'A linked card shows “✓ Linked to” a voter. If it is wrong, tap “Undo — not them”. Matches on an exact email or phone may be linked automatically, and are labelled so.',
    },
    {
      heading: 'Flags to respect',
      body: '“unsubscribed — do not email” means exactly that. “email unconfirmed” means they have not clicked the confirmation link yet.',
    },
    {
      heading: 'Handled',
      body: '“Mark handled” takes a card out of the queue once it has been dealt with. Tick “Show handled too” to see them again, and “Reopen” to put one back.',
    },
  ],
};

export const MESSAGING_HELP: HelpTopic = {
  title: 'How messaging works',
  spoken: [
    'Messaging sends texts and emails only to people who agreed to hear from the campaign.',
    'Each campaign goes only to people who consented to its purpose, and anyone who says stop is never messaged again.',
    'Nothing is sent until you test it on your own phone, approve it, and start it.',
    'Sending is a slow drip over hours or days, so plan ahead for election week.',
  ],
  sections: [
    {
      heading: 'Writing a campaign',
      body: '“New campaign” opens the composer. Give it a name (only the team sees it), choose the purpose, Get out the vote or Campaign updates, narrow by ward or community if you like, and write the text and optional email. “Save draft” only stores it.',
    },
    {
      heading: 'Who it reaches',
      body: 'A campaign only goes to people who ticked yes to that purpose at the door or online. With no wards or communities ticked, everyone who consented to that purpose is counted.',
    },
    {
      heading: 'Text length and cost',
      body: 'Keep “Reply STOP to stop.” in the text; you will be warned if it is missing. The meter shows characters and billed segments, and “Replace smart punctuation” swaps curly quotes that make a text cost more.',
    },
    {
      heading: 'Test, approve, start',
      body: 'First “Send me this first” to your own mobile. Then “Approve this campaign”, which restates the audience and how long it will take and asks you to type APPROVE. Approving still sends nothing; “Start sending” begins the drip.',
    },
    {
      heading: 'After approval',
      body: 'An approved campaign can no longer be edited. If the wording is wrong, use “Cancel campaign” and write a new one.',
    },
    {
      heading: 'While it is sending',
      body: 'Pause stops it temporarily and Resume carries on. Sending pauses outside 09:00–21:30 on weekdays and 10:00–18:00 at weekends, so it can take longer than you expect.',
    },
    {
      heading: 'Sending numbers',
      body: 'This tab shows each number, how much it has sent today and its daily cap. The caps are the ceiling for every campaign, so a big send takes days.',
    },
  ],
};

export const REPORTS_HELP: HelpTopic = {
  title: 'How reports work',
  spoken: [
    'Reports has three tabs: follow ups, activity, and unreachable.',
    'Follow ups lists doors where a canvasser promised to come back.',
    'Activity shows who has been out knocking and how many doors were recorded each day.',
    'Unreachable explains which doors are hard to reach and what to do about each kind.',
    'The notes here come from the doorstep, so treat them as carefully as the voters list.',
  ],
  sections: [
    {
      heading: 'Follow-ups',
      body: 'Doors where the latest visit ticked “Needs a follow-up”, newest first, with the note left at the door. Filter by ward, and use “Show this door on the map” to find it.',
    },
    {
      heading: 'Clearing a follow-up',
      body: 'There is no done button here. A door drops off the list when someone records a newer visit at it without ticking follow-up.',
    },
    {
      heading: 'Activity',
      body: 'Choose 7, 14 or 30 days. The tiles total contacts, active canvassers, contacts per day and the busiest day, followed by a daily chart and a table by canvasser with each person’s last active day.',
    },
    {
      heading: 'Unreachable',
      body: 'Splits hard-to-reach doors into “Known before you leave the house” (from the list itself: no map point, institutions, PO boxes, non-resident owners) and “Learned at the door” (refusals, do-not-knock, moved and so on). Each comes with a plain “What to do”.',
    },
    {
      heading: 'Advice',
      body: 'If the campaign has switched it on, an Advice box adds a written summary. It is only ever given the counts, never a name or address.',
    },
  ],
};

export const STATS_HELP: HelpTopic = {
  title: 'How the stats page works',
  spoken: [
    'Stats is an overview of the whole voters list.',
    'The tiles at the top count households, voters, residents, non-resident owners and more.',
    'The charts break the list down by ward, by community, by voters per door, and by record quality.',
    'The canvass section shows doors contacted and how support is spread.',
  ],
  sections: [
    {
      heading: 'The totals',
      body: 'Households, Voters, Residents, Non-resident owners, Institutions, Unmapped parcels (legal descriptions) and PO-box-only doors, for all of Middlesex Centre.',
    },
    {
      heading: 'Breakdowns',
      body: 'Bar charts show households and voters by ward and by community, and how many households have 1, 2, 3 or more voters.',
    },
    {
      heading: 'Record quality',
      body: 'Good is an exact address match, Approximate is the nearest point on the street, Legal has no civic address, and Check needs review.',
    },
    {
      heading: 'Canvass',
      body: 'Doors contacted, contacts today and contacts in the last 7 days, plus a chart of support recorded at the door on the 1 to 5 scale.',
    },
  ],
};

export const USERS_HELP: HelpTopic = {
  title: 'How the users page works',
  spoken: [
    'This page is for admins to manage who can sign in.',
    'Invite someone with their email, name and role, then send them the link privately.',
    'The link works once and expires after a week.',
    'You can change a person’s role, send a fresh invite, or deactivate their account.',
  ],
  sections: [
    {
      heading: 'Inviting someone',
      body: 'Fill in Email, Name and Role, then “Create invite”. Use “Copy link” and send it to them privately; it works once and expires in 7 days.',
    },
    {
      heading: 'Roles',
      body: 'A volunteer sees only the doors in turfs assigned to them, never mailing addresses or resident status. An organizer can build turfs, see every door, search and run reports. An admin can also manage users and read the audit log.',
    },
    {
      heading: 'Changing an account',
      body: 'Change a role with the menu on each row. “Re-invite” or “Reset (re-invite)” issues a new link, and Deactivate stops someone signing in; Reactivate reverses it.',
    },
    {
      heading: 'Things you cannot do',
      body: 'You cannot change your own role or deactivate yourself. The last active admin cannot be demoted, so promote someone else first.',
    },
    {
      heading: 'Status column',
      body: '“invite pending” means they have not used their link yet, and “deactivated” means they cannot sign in. Last sign-in shows when each person was last here.',
    },
  ],
};

export const AUDIT_HELP: HelpTopic = {
  title: 'How the audit log works',
  spoken: [
    'The audit log records every sign in, household view, search, invite and user change.',
    'It exists to show that the voters list was handled properly, as the law requires.',
    'Filter by person or by action to find what you need.',
    'Entries here describe voter data, so keep them confidential too.',
  ],
  sections: [
    {
      heading: 'What is recorded',
      body: 'Every sign-in, household view, search, invite and user change, with who did it and when. Reads of doorstep notes, sign requests and sign photos are logged too.',
    },
    {
      heading: 'Why it exists',
      body: 'The voters list is personal information under Ontario’s Municipal Elections Act. This log is the record that shows it was used only for the campaign.',
    },
    {
      heading: 'Finding an entry',
      body: 'Use the User and Action menus to narrow the list. The newest entries come first; tap “Load older entries” at the bottom to go further back.',
    },
    {
      heading: 'Keep it private',
      body: 'The Target / detail column can point at real households, so do not copy or share it outside the campaign.',
    },
  ],
};

export const ACCOUNT_HELP: HelpTopic = {
  title: 'How the account page works',
  spoken: [
    'This is your account page.',
    'You can change your password here, which signs you out on every other device.',
    'You can choose the voice the app speaks with, and test it.',
    'The data section shows when the voters list was imported, and reminds you it is confidential.',
    'Sign out is at the top when you are finished.',
  ],
  sections: [
    {
      heading: 'Change password',
      body: 'Enter your current password and a new one of at least 10 characters, twice. Changing it signs out every other device you are signed in on.',
    },
    {
      heading: 'Voice',
      body: 'Choose the voice used for drive mode and for spoken help, then tap “Test voice”. It is saved on this device only.',
    },
    {
      heading: 'Online voices',
      body: 'Some voices are online, which means the words are sent to that provider to be spoken. That is acceptable only because the app never speaks a name or an address.',
    },
    {
      heading: 'Data',
      body: 'Shows the source and date of the voters list and how many households and voters it holds. The list is personal information under Ontario’s Municipal Elections Act: use it for this campaign only, do not copy or share it, and expect every lookup to be logged.',
    },
    {
      heading: 'About this app',
      body: 'Shows the version number, with Changelog, “How it works” and Roadmap buttons and a GitHub link.',
    },
  ],
};
