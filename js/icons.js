// A hand-built inline SVG icon set.
//
// The chrome used emoji (💬 🔔 🔖 🔍 📌 👥). Emoji are rendered by the operating
// system, so the same button is a flat glyph on Windows, a glossy 3D blob on
// Android and something else again on a Mac - three different products in three
// screenshots. These are drawn once, inherit currentColor so they follow the
// theme for free, and stay pixel-crisp at any size.
//
// All icons are on a 24x24 grid, 1.75 stroke, round caps and joins, so they sit
// together as one family. Emoji remain where they are CONTENT (reactions, custom
// status, a person's chosen emoji) - only interface chrome is drawn here.

const P = (d, extra = '') =>
  `<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"${extra ? ' ' + extra : ''}/>`;

export const ICONS = {
  // ---- navigation / panels ----
  thread: P('M21 11.5a8.4 8.4 0 0 1-9 8.4 9.1 9.1 0 0 1-3.3-.6L3 21l1.9-5a8.2 8.2 0 0 1-.9-3.8 8.4 8.4 0 0 1 8.5-8.2 8.4 8.4 0 0 1 8.5 8z')
    + P('M8.5 10h7M8.5 13.5h4.5'),
  bell: P('M18 8.5a6 6 0 1 0-12 0c0 6-2 7.5-2 7.5h16s-2-1.5-2-7.5')
    + P('M13.7 20a2 2 0 0 1-3.4 0'),
  bookmark: P('M18.5 20 12 15.6 5.5 20V5.5A1.5 1.5 0 0 1 7 4h10a1.5 1.5 0 0 1 1.5 1.5z'),
  search: `<circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="1.75"/>`
    + P('m20 20-4.7-4.7'),
  pin: P('M9 4h6l-.7 5.2 3 3.1V14H6.7v-1.7l3-3.1z') + P('M12 14v6'),
  members: `<circle cx="9.5" cy="8.5" r="3.3" fill="none" stroke="currentColor" stroke-width="1.75"/>`
    + P('M3.5 19.5a6.2 6.2 0 0 1 12 0') + P('M16.5 6.2a3.3 3.3 0 0 1 0 6.4M17.6 14.4a6.2 6.2 0 0 1 3.4 5.1'),
  settings: `<circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.75"/>`
    + P('M19.2 14.4a1.5 1.5 0 0 0 .3 1.7l.1.1a1.8 1.8 0 1 1-2.6 2.6l-.1-.1a1.5 1.5 0 0 0-1.7-.3 1.5 1.5 0 0 0-.9 1.4v.2a1.8 1.8 0 1 1-3.6 0v-.1a1.5 1.5 0 0 0-1-1.4 1.5 1.5 0 0 0-1.7.3l-.1.1a1.8 1.8 0 1 1-2.6-2.6l.1-.1a1.5 1.5 0 0 0 .3-1.7 1.5 1.5 0 0 0-1.4-.9h-.2a1.8 1.8 0 1 1 0-3.6h.1a1.5 1.5 0 0 0 1.4-1 1.5 1.5 0 0 0-.3-1.7l-.1-.1a1.8 1.8 0 1 1 2.6-2.6l.1.1a1.5 1.5 0 0 0 1.7.3h.1a1.5 1.5 0 0 0 .9-1.4v-.2a1.8 1.8 0 1 1 3.6 0v.1a1.5 1.5 0 0 0 .9 1.4 1.5 1.5 0 0 0 1.7-.3l.1-.1a1.8 1.8 0 1 1 2.6 2.6l-.1.1a1.5 1.5 0 0 0-.3 1.7v.1a1.5 1.5 0 0 0 1.4.9h.2a1.8 1.8 0 1 1 0 3.6h-.1a1.5 1.5 0 0 0-1.4.9z'),
  shield: P('M12 3.5 5 6.4v5c0 4.3 3 8.3 7 9.3 4-1 7-5 7-9.3v-5z') + P('m9.3 11.8 1.9 1.9 3.6-3.6'),
  plug: P('M9 3v5M15 3v5') + P('M7 8h10v3a5 5 0 0 1-10 0z') + P('M12 16v5'),
  clock: `<circle cx="12" cy="12" r="8.2" fill="none" stroke="currentColor" stroke-width="1.75"/>` + P('M12 7.4V12l3 1.8'),
  keyboard: P('M3.5 6.5h17v11h-17z') + P('M7 10h.01M10.5 10h.01M14 10h.01M17 10h.01M8 14h8'),
  chart: P('M4 20V10M10 20V4M16 20v-7M22 20H2'),
  doc: P('M14 3.5H7.5A1.5 1.5 0 0 0 6 5v14a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V7.5z')
    + P('M14 3.5V7a.5.5 0 0 0 .5.5H18M9 12h6M9 15.5h6'),
  // Ruled cells, not `doc` with lines in it and not `chart`. A pinned sheet has
  // to be tellable apart from a pinned document at 14px in a row of pills,
  // which is the size the channel bar draws them at on a phone.
  sheet: P('M4.5 5.5A1 1 0 0 1 5.5 4.5h13a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1z')
    + P('M4.5 9.5h15M4.5 14.5h15M10.5 9.5v10'),
  calendar: P('M5 6.5h14v13H5z') + P('M8 3.5v4M16 3.5v4M5 11h14'),
  hash: P('M5 9.5h14M5 14.5h14M10.2 4l-1.4 16M16 4l-1.4 16'),
  // A bullhorn, not a speaker cone - it sat next to `volume` and the two were
  // indistinguishable at 20px, which is where an icon set stops being a set.
  megaphone: P('M4 11.5v1.8a2 2 0 0 0 1.6 2l11.9 2.4a1 1 0 0 0 1.2-1V8.3a1 1 0 0 0-1.2-1L5.6 9.6a2 2 0 0 0-1.6 2z')
    + P('M7.5 15.6V19a1.5 1.5 0 0 0 3 0v-2.8') + P('M21 10.5v4'),
  lock: P('M6.5 10.5h11v9h-11z') + P('M9 10.5V8a3 3 0 0 1 6 0v2.5'),
  volume: P('M4 10v4a1 1 0 0 0 1 1h2.5L12 19V5L7.5 9H5a1 1 0 0 0-1 1z') + P('M16 9.5a3.5 3.5 0 0 1 0 5M18.5 7a7 7 0 0 1 0 10'),
  // The same speaker with the slash `micOff` uses, rather than the X other sets
  // put on it, so the two off-states in a voice room are one gesture instead of
  // two conventions. It serves the unmute button and the undeafen button alike,
  // because both say the same thing to the person looking at them: no sound is
  // getting through.
  volumeOff: P('M4 10v4a1 1 0 0 0 1 1h2.5L12 19V5L7.5 9H5a1 1 0 0 0-1 1z') + P('m4 4 16 16'),

  // ---- state, callouts and places ----
  // A tray, for the Later queue. Not `bookmark`, which is already the button
  // that puts a message into that queue, and not `download`, which promises a
  // file lands on your disk.
  inbox: P('M20.5 12.5H16l-1.6 2.6H9.6L8 12.5H3.5')
    + P('M6.3 5.6 3.5 12v5.5A1.5 1.5 0 0 0 5 19h14a1.5 1.5 0 0 0 1.5-1.5V12l-2.8-6.4a1.5 1.5 0 0 0-1.4-.9H7.7a1.5 1.5 0 0 0-1.4.9z'),
  // Slowmode. The banner used a turtle, which is a mascot rather than an icon and
  // shared nothing with the rest of the set. An hourglass says the same thing,
  // that you are being held back, and `clock` was not free to say it because it
  // already means a timestamp and a send-later everywhere else.
  hourglass: P('M7 3.5h10M7 20.5h10')
    + P('M8.5 3.5v3.4a2 2 0 0 0 .7 1.5L12 12l-2.8 3.6a2 2 0 0 0-.7 1.5v3.4')
    + P('M15.5 3.5v3.4a2 2 0 0 1-.7 1.5L12 12l2.8 3.6a2 2 0 0 1 .7 1.5v3.4'),
  alert: P('M10.6 5 3.4 17.7A1.6 1.6 0 0 0 4.8 20.1h14.4a1.6 1.6 0 0 0 1.4-2.4L13.4 5a1.6 1.6 0 0 0-2.8 0z')
    + P('M12 10v4.2M12 17.3h.01'),
  // A place on a map, which is what an event's location is. Kept apart from
  // `pin` on purpose: that one is the pushpin holding a message at the top of a
  // channel, and an address is not pinned to anything.
  mapPin: P('M12 20.6c4-4.5 6-7.8 6-10.1a6 6 0 1 0-12 0c0 2.3 2 5.6 6 10.1z')
    + `<circle cx="12" cy="10.3" r="2.4" fill="none" stroke="currentColor" stroke-width="1.75"/>`,
  // An office block for an organisation, and a folder for browsing what is
  // inside one. The Servers chooser stacks five of these cards, so each glyph
  // has to be told from its neighbours at a glance rather than merely be right.
  building: P('M4.5 20.5V5.5A1.5 1.5 0 0 1 6 4h7a1.5 1.5 0 0 1 1.5 1.5v15')
    + P('M14.5 10.5H18A1.5 1.5 0 0 1 19.5 12v8.5') + P('M3 20.5h18')
    + P('M8 7.5h3M8 11h3M8 14.5h3M17 14.5h.01M17 17.5h.01'),
  folder: P('M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2.5h8A1.5 1.5 0 0 1 20.5 10v7.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z'),
  // Presence. A filled dot for active, a barred circle for do not disturb, and
  // away reuses `moon` further down. The dot is filled rather than stroked
  // because at 16px a hollow ring reads as empty, which is the wrong thing to
  // say about somebody who is sitting at their desk.
  dot: `<circle cx="12" cy="12" r="5" fill="currentColor"/>`,
  dnd: `<circle cx="12" cy="12" r="8.2" fill="none" stroke="currentColor" stroke-width="1.75"/>` + P('M8.2 12h7.6'),

  // ---- message actions ----
  reply: P('M9 7 4 12l5 5') + P('M4 12h9a6 6 0 0 1 6 6v1'),
  forward: P('m15 7 5 5-5 5') + P('M20 12h-9a6 6 0 0 0-6 6v1'),
  smile: `<circle cx="12" cy="12" r="8.2" fill="none" stroke="currentColor" stroke-width="1.75"/>`
    + P('M8.8 14a4 4 0 0 0 6.4 0') + P('M9.3 9.6h.01M14.7 9.6h.01'),
  more: `<circle cx="6" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="18" cy="12" r="1.5" fill="currentColor"/>`,
  plus: P('M12 5.5v13M5.5 12h13'),
  close: P('m6.5 6.5 11 11M17.5 6.5l-11 11'),
  check: P('m5 12.5 4.5 4.5L19 7.5'),
  trash: P('M4.5 7h15') + P('M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7')
    + P('M6.5 7l.8 12A1.5 1.5 0 0 0 8.8 20.5h6.4a1.5 1.5 0 0 0 1.5-1.4l.8-12'),
  edit: P('M16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1 1-4z'),
  link: P('M10.5 13.5a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7l-1.6 1.6')
    + P('M13.5 10.5a4 4 0 0 0-5.7 0L5 13.3a4 4 0 0 0 5.7 5.7l1.6-1.6'),
  // A topic is a label tied to one message, not a folder the message lives in,
  // so it is the luggage tag rather than anything filing-shaped.
  tag: P('M12.6 3.5H19a1.5 1.5 0 0 1 1.5 1.5v6.4a1.5 1.5 0 0 1-.44 1.06l-7.5 7.5a1.5 1.5 0 0 1-2.12 0l-6.4-6.4a1.5 1.5 0 0 1 0-2.12l7.5-7.5A1.5 1.5 0 0 1 12.6 3.5z')
    + `<circle cx="16.3" cy="7.7" r="1.3" fill="none" stroke="currentColor" stroke-width="1.75"/>`,
  // A rosette, for setting a reaction role. `members` already carries the roles
  // panel, and putting that same glyph on a message action would claim the two
  // buttons do the same thing when one opens a list and the other arms a rule.
  badge: `<circle cx="12" cy="9.3" r="5.5" fill="none" stroke="currentColor" stroke-width="1.75"/>`
    + P('M8.7 13.7 7.3 20.6l4.7-2.4 4.7 2.4-1.4-6.9'),

  // ---- composer ----
  paperclip: P('M20 11.5 12.3 19a5 5 0 0 1-7-7l8-8a3.4 3.4 0 0 1 4.8 4.8l-8 8a1.7 1.7 0 0 1-2.4-2.4l7.3-7.3'),
  send: P('m5 12 15-7-6 15-2.6-6z') + P('m11.4 14 8.6-9'),
  slash: P('M14.5 4 9.5 20'),
  code: P('m9 8-5 4 5 4M15 8l5 4-5 4'),
  image: P('M4.5 5.5h15v13h-15z') + P('m4.5 15.5 4-4 4 4 3-3 3.5 3.5')
    + `<circle cx="9" cy="9.5" r="1.3" fill="none" stroke="currentColor" stroke-width="1.75"/>`,
  mic: P('M12 4a2.5 2.5 0 0 1 2.5 2.5v5a2.5 2.5 0 0 1-5 0v-5A2.5 2.5 0 0 1 12 4z')
    + P('M6.5 11a5.5 5.5 0 0 0 11 0M12 16.5V20'),
  micOff: P('M9.5 6.4A2.5 2.5 0 0 1 14.5 6.5v4M9.5 10.5v1a2.5 2.5 0 0 0 4.2 1.8')
    + P('M6.5 11a5.5 5.5 0 0 0 8.4 4.7M12 16.5V20') + P('m4 4 16 16'),
  // The handset. Deliberately the same silhouette every phone on earth uses, at
  // this grid and this stroke: an icon that means "call" has exactly one shape
  // people already know, and being clever with it costs recognition for nothing.
  phone: P('M7.6 4.5h-2A1.6 1.6 0 0 0 4 6.2 14.4 14.4 0 0 0 17.8 20a1.6 1.6 0 0 0 1.7-1.6v-2a1.1 1.1 0 0 0-.9-1.1l-2.5-.5a1.1 1.1 0 0 0-1.1.5l-.8 1.2a11 11 0 0 1-5.4-5.4l1.2-.8a1.1 1.1 0 0 0 .5-1.1l-.5-2.5a1.1 1.1 0 0 0-1.1-.9z'),
  // Hanging up is the SAME handset, turned down. The first draft used this set's
  // usual slash (micOff, volumeOff) and it was wrong at 26px: a diagonal stroke
  // across a shape that is already diagonal reads as a smudge, not as a "no".
  // Rotation is what every phone on earth uses for this and it survives being
  // small, which is the only size it is ever seen at.
  phoneOff: `<g transform="rotate(135 12 12)">`
    + P('M7.6 4.5h-2A1.6 1.6 0 0 0 4 6.2 14.4 14.4 0 0 0 17.8 20a1.6 1.6 0 0 0 1.7-1.6v-2a1.1 1.1 0 0 0-.9-1.1l-2.5-.5a1.1 1.1 0 0 0-1.1.5l-.8 1.2a11 11 0 0 1-5.4-5.4l1.2-.8a1.1 1.1 0 0 0 .5-1.1l-.5-2.5a1.1 1.1 0 0 0-1.1-.9z')
    + `</g>`,
  headphones: P('M4 14v-2a8 8 0 0 1 16 0v2')
    + P('M4 14h2.5a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM20 14h-2.5a1 1 0 0 0-1 1v3a1 1 0 0 0 1 1H19a1 1 0 0 0 1-1z'),

  // ---- misc ----
  download: P('M12 4v11') + P('m7.5 11 4.5 4.5 4.5-4.5') + P('M4.5 19.5h15'),
  sun: `<circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="1.75"/>`
    + P('M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4'),
  moon: P('M20 14.3A8.5 8.5 0 1 1 9.7 4a6.6 6.6 0 0 0 10.3 10.3z'),
  contrast: `<circle cx="12" cy="12" r="8.2" fill="none" stroke="currentColor" stroke-width="1.75"/>`
    + `<path d="M12 3.8a8.2 8.2 0 0 1 0 16.4z" fill="currentColor"/>`,
  menu: P('M4 7h16M4 12h16M4 17h16'),
  chevronDown: P('m7 10 5 5 5-5'),
  chevronLeft: P('m14 7-5 5 5 5'),
  chevronRight: P('m10 7 5 5-5 5'),
  arrowDown: P('M12 5v13') + P('m6.5 12.5 5.5 5.5 5.5-5.5'),
  logout: P('M15 8V6a1.5 1.5 0 0 0-1.5-1.5h-7A1.5 1.5 0 0 0 5 6v12a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 15 18v-2')
    + P('M19 12H9.5') + P('m16 9 3 3-3 3'),

  // ---- sharing an organisation ----
  // Two sheets, the front one offset. Deliberately not a clipboard: a clipboard
  // reads as "paste" to about half of people, and this button only ever copies.
  copy: P('M9 9V6.5A1.5 1.5 0 0 1 10.5 5h7A1.5 1.5 0 0 1 19 6.5v7a1.5 1.5 0 0 1-1.5 1.5H15')
    + P('M13.5 9h-7A1.5 1.5 0 0 0 5 10.5v7A1.5 1.5 0 0 0 6.5 19h7a1.5 1.5 0 0 0 1.5-1.5v-7A1.5 1.5 0 0 0 13.5 9z'),
  // Three finder squares and a scatter of modules - the shape everybody already
  // reads as "point your camera at this", without pretending to be a real code.
  qr: P('M4.5 4.5h5v5h-5zM14.5 4.5h5v5h-5zM4.5 14.5h5v5h-5z')
    + P('M14.5 14.5h2v2h-2zM17.5 17.5h2v2h-2zM14.5 19.5h1M19.5 14.5h0'),
  // A closed envelope. The flap is a separate stroke so it stays legible at 20px.
  mail: P('M4 7.5A1.5 1.5 0 0 1 5.5 6h13A1.5 1.5 0 0 1 20 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 16.5z')
    + P('m4.5 8 7.5 5 7.5-5'),
  // The OS share affordance: a node with two branches leaving it.
  share: `<circle cx="17.5" cy="6" r="2.5" fill="none" stroke="currentColor" stroke-width="1.75"/>`
    + `<circle cx="6.5" cy="12" r="2.5" fill="none" stroke="currentColor" stroke-width="1.75"/>`
    + `<circle cx="17.5" cy="18" r="2.5" fill="none" stroke="currentColor" stroke-width="1.75"/>`
    + P('m8.7 10.8 6.6-3.6m0 9.6-6.6-3.6'),
  // Safari's own share control, the box with an arrow leaving the top of it. The
  // Add to Home Screen sheet tells somebody to go and tap a specific button on
  // their phone, so the picture has to be the one that is actually down there:
  // `share` above is the three-node affordance, which iOS does not draw.
  shareIos: P('M12 3.5v11') + P('m8.3 7.2 3.7-3.7 3.7 3.7')
    + P('M8 9.5H6A1.5 1.5 0 0 0 4.5 11v8A1.5 1.5 0 0 0 6 20.5h12a1.5 1.5 0 0 0 1.5-1.5v-8A1.5 1.5 0 0 0 18 9.5h-2'),
  // WhatsApp's mark, filled rather than stroked, because that is the only form
  // people recognise at a glance - and recognition is the entire job of this one
  // button. Everything these workers already coordinate on is in that app, so
  // the invite has to leave through it.
  whatsapp: '<path fill="currentColor" d="M12.04 2.5a9.4 9.4 0 0 0-8.1 14.1L2.5 21.5l4.98-1.3a9.4 9.4 0 1 0 4.56-17.7m0 1.7a7.7 7.7 0 1 1-3.9 14.34l-.28-.17-2.95.77.79-2.88-.19-.3A7.7 7.7 0 0 1 12.04 4.2m-3.3 3.6c-.16 0-.42.06-.64.3-.22.24-.85.83-.85 2.02s.87 2.34.99 2.5c.12.16 1.7 2.72 4.19 3.7 2.07.82 2.49.66 2.94.62.45-.04 1.45-.59 1.66-1.17.2-.57.2-1.06.14-1.16-.06-.1-.22-.16-.46-.28s-1.45-.72-1.67-.8c-.22-.08-.39-.12-.55.12s-.63.8-.77.96c-.14.16-.28.18-.52.06a6.7 6.7 0 0 1-1.97-1.21 7.4 7.4 0 0 1-1.36-1.7c-.14-.24-.01-.37.11-.49.11-.11.24-.28.36-.42.12-.14.16-.24.24-.4.08-.16.04-.3-.02-.42s-.55-1.33-.75-1.82c-.2-.48-.4-.41-.55-.42z"/>',
};

// icon('search')            -> markup, sized by CSS
// icon('search', {size:18}) -> explicit size when a container cannot decide
export function icon(name, { size, cls = '' } = {}) {
  const body = ICONS[name];
  if (!body) return '';
  const dim = size ? ` width="${size}" height="${size}"` : '';
  return `<svg class="ico${cls ? ' ' + cls : ''}" viewBox="0 0 24 24"${dim} `
    + `aria-hidden="true" focusable="false">${body}</svg>`;
}

export const hasIcon = (name) => !!ICONS[name];

// The wordmark, used on the sign-in screen and as the fallback Space glyph.
//
// This was a flame, because the product was called Hearth. Under the name Dak
// a fireplace means nothing, and a mark that has to be explained is not a mark.
// So it says what the product is instead: one conversation, and a second one
// growing out of it without covering it up. That is the thread contract, which
// is the whole reason this exists rather than a WhatsApp group.
//
// The warmth is inherited deliberately - Redtree is the parent brand, and the
// family resemblance is worth keeping even when the shape is not.
//
// THE MARK DOES NOT FOLLOW THE THEME, AND THAT IS THE FIX. The plate under it
// used to be fill="var(--c-nav-bg, #1a1030)" while the bubble sitting on top of
// the plate stayed a literal #fff2e8. That holds only while every theme happens
// to have a dark nav ground: the moment a look ships a pale one, the mark paints
// a near-white bubble on a near-white plate and disappears off the sign-in card
// with nothing on screen to say why. Half of the mark followed the theme and the
// other half did not, which is the bug rather than the styling.
//
// It is pinned instead of tokenised because only two of the four colours here
// could ever have been tokens - the gradient and the two dots are brand orange,
// and there is no token that means "brand orange" - so a token-following plate
// could only ever be half a fix. Every colour is a fixed literal, the plate
// covers the whole viewBox, and the mark therefore carries its own ground: it
// reads identically on all eight themes and on every theme added after them,
// which is exactly what a brand asset is supposed to do.
export function logoMark(size = 40) {
  return `<svg class="logo-mark" width="${size}" height="${size}" viewBox="0 0 48 48"
    aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id="dakMark" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#ff8a4c"/>
        <stop offset="60%" stop-color="#f05a3c"/>
        <stop offset="100%" stop-color="#d93b52"/>
      </linearGradient>
    </defs>
    <!-- the plate: the mark's own ground, deliberately NOT var(--c-nav-bg) -->
    <rect x="1" y="1" width="46" height="46" rx="13" fill="#1a1030"/>
    <!-- the room: a full bubble with its tail at the lower left -->
    <path d="M10 17a7 7 0 0 1 7-7h11a7 7 0 0 1 7 7v5a7 7 0 0 1-7 7h-8.6L13 34.4a1 1 0 0 1-1.6-.8V29a7 7 0 0 1-1.4-4.2z"
      fill="url(#dakMark)"/>
    <!-- the thread: offset, overlapping, never obscuring the message it answers -->
    <path d="M25 26.5a5.5 5.5 0 0 1 5.5-5.5h5A5.5 5.5 0 0 1 41 26.5v3.8a5.5 5.5 0 0 1-5.5 5.5H35v3.1a.8.8 0 0 1-1.3.6l-4.3-3.7h-.9a5.5 5.5 0 0 1-5.5-5.5z"
      fill="#fff2e8"/>
    <circle cx="29.6" cy="28.6" r="1.55" fill="#f05a3c"/>
    <circle cx="35.4" cy="28.6" r="1.55" fill="#f05a3c"/>
  </svg>`;
}
