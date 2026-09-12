// Reading a spreadsheet link well enough to know what can be done with it.
//
// The teams this exists for live in Google Sheets: the volunteer roster, the
// patient call list, the camp attendance tracker. Today sharing one means
// pasting a URL into a channel, where it is twenty messages up by the next
// morning and nobody can find it on a phone.
//
// THE CONSTRAINT THAT SHAPES EVERYTHING HERE. An ordinary /edit URL cannot be
// put in an iframe. Google serves the editor with X-Frame-Options: SAMEORIGIN,
// so the browser refuses the frame before any of our code runs, and there is no
// sandbox value, referrer policy or header on our side that changes that.
// Reading the cells out instead would need Google OAuth plus the Sheets API,
// which is a credential nobody has issued us.
//
// What IS frameable is a sheet whose owner has run File > Share > Publish to
// web. That produces /spreadsheets/d/e/<id>/pubhtml (or /pub?output=...) and
// Google serves those WITHOUT the frame refusal - it is the same URL their own
// Embed tab hands out. So the whole product decision collapses to one question
// about a pasted link, and answering it is all this file does:
//
//   embeddable true   open it inside Dek
//   embeddable false  open a tab, and say once that publishing changes this
//
// Pure: no DOM, no network, no imports. scripts/probe-sheets.mjs runs it against
// a table of real-shaped URLs including the ones people actually paste - a
// /u/0/ account prefix, a trailing #gid=0, ?usp=sharing, and plain http.

// Hosts. spreadsheets.google.com is the pre-2011 host and still redirects, so
// links that old are still in circulation inside long-lived channels.
const GOOGLE_HOSTS = ['docs.google.com', 'drive.google.com', 'spreadsheets.google.com'];

// Microsoft's spreadsheet surface has four host families depending on whether
// the tenant is consumer OneDrive, a short link, SharePoint Online or the
// Office web apps. All four land on the same answer - not frameable by us -
// so they share one kind rather than four.
const EXCEL_HOSTS = ['onedrive.live.com', '1drv.ms', 'sharepoint.com', 'office.com',
  'officeapps.live.com', 'office.net'];

// name  what the thing is, for a label:      "Sheet"
// app   where the escape hatch sends you:     "Open in Google Sheets"
// full  how a sentence about it reads:        "Google Sheet - opens in a new tab"
// Three fields and not two, because "Google Sheets sheet" is what one field
// gets you and it reads as a bug.
const FAMILY = {
  spreadsheets: { kind: 'gsheet', pub: 'gsheet-pub', name: 'Sheet', app: 'Google Sheets', full: 'Google Sheet' },
  document: { kind: 'gdoc', pub: 'gdoc-pub', name: 'Doc', app: 'Google Docs', full: 'Google Doc' },
  presentation: { kind: 'gslides', pub: 'gslides-pub', name: 'Slides', app: 'Google Slides', full: 'Google Slides' },
  forms: { kind: 'gform', pub: 'gform', name: 'Form', app: 'Google Forms', full: 'Google Form' },
};

// The last path segment that means "Google will let this be framed". Split by
// family because the answer genuinely differs: a presentation has a documented
// /embed that a spreadsheet does not, and a form is frameable at its ordinary
// fill-in URL because embedding a form is the supported way to collect replies.
const FRAMEABLE_TAIL = {
  spreadsheets: ['pubhtml', 'pub'],
  document: ['pub'],
  presentation: ['pub', 'pubembed', 'embed'],
  forms: ['viewform'],
};

const hostIn = (host, list) => list.some((h) => host === h || host.endsWith('.' + h));

const SHEETY = new Set(['gsheet', 'gsheet-pub', 'excel']);
const DOCCY = new Set(['gdoc', 'gdoc-pub', 'gslides', 'gslides-pub', 'gform', 'gdrive']);

// Is this pin a document of some kind rather than a bare link? The bar groups
// on this, so it has to include the Microsoft and Drive kinds too - a roster
// that happens to live on SharePoint is still the roster.
export const isDocKind = (kind) => SHEETY.has(kind) || DOCCY.has(kind);
export const isSheetKind = (kind) => SHEETY.has(kind);

// Somebody typing a link on a phone leaves the scheme off, and so does a URL
// copied out of a WhatsApp preview. Refusing that would be refusing the most
// common paste in the building.
function normalise(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s) && /^[\w-]+(\.[\w-]+)+(\/|$|\?|#)/.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return u;
}

// /u/0/ is the signed-in-account selector Google splices into a copied URL. It
// appears either before or after the family segment depending on how old the
// link is, and it carries the ACCOUNT NUMBER of whoever copied it - which is
// meaningless to everybody else and breaks the match if left in place.
function segments(pathname) {
  const raw = pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === 'u' && /^\d+$/.test(raw[i + 1] || '')) { i++; continue; }
    out.push(raw[i]);
  }
  return out;
}

/**
 * Classify a pasted URL.
 * Returns { kind, url, host, id, gid, name, app, full, embeddable, publishable }
 * and never throws: an unparseable string comes back as kind 'link'.
 */
export function classifySheetUrl(raw) {
  const u = normalise(raw);
  const text = String(raw == null ? '' : raw).trim();
  if (!u) return { kind: 'link', url: text, host: '', id: null, gid: null,
    name: 'Link', app: '', full: 'Link', embeddable: false, publishable: false, valid: false };

  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const segs = segments(u.pathname);
  const base = { kind: 'link', url: u.href, host, id: null, gid: null,
    name: 'Link', app: '', full: 'Link', embeddable: false, publishable: false, valid: true };

  // gid names the TAB, and a roster's second tab is a different list from its
  // first. It rides in the HASH on an edit URL and in the QUERY on a published
  // one, so reading only one of the two silently drops half of them. The stored
  // URL keeps it either way; this is reported so a caller can tell a
  // whole-file pin from a single-tab pin without re-parsing.
  const gid = (u.hash.match(/[#&]gid=(\d+)/) || [])[1] || u.searchParams.get('gid') || null;

  if (hostIn(host, GOOGLE_HOSTS)) {
    const fam = FAMILY[segs[0]];
    if (fam) {
      const di = segs.indexOf('d');
      // /d/e/<id> is the published-document id space. It is a different id from
      // the /d/<id> one and the two are not interchangeable.
      const published = di >= 0 && segs[di + 1] === 'e';
      const id = di < 0 ? null : (published ? segs[di + 2] : segs[di + 1]) || null;
      const tail = segs[segs.length - 1] || '';
      // The tail decides, not /d/e/ on its own: /d/e/<id>/pub?output=csv is a
      // published document whose frame would be a file download, not a view.
      const frameable = (FRAMEABLE_TAIL[segs[0]] || []).includes(tail);
      return { ...base, kind: published || frameable ? fam.pub : fam.kind, id, gid,
        name: fam.name, app: fam.app, full: fam.full,
        embeddable: frameable,
        // Only an unpublished Google file is fixed by publishing it. Telling
        // somebody to publish a SharePoint link, or a sheet they already
        // published, is advice that leads nowhere.
        publishable: !published && !frameable };
    }
    // drive.google.com/file/d/<id>/preview is Drive's own embed URL and is the
    // one Drive path that frames. /view next to it does not.
    if (host === 'drive.google.com' && segs[0] === 'file') {
      const di = segs.indexOf('d');
      return { ...base, kind: 'gdrive', id: segs[di + 1] || null, name: 'File',
        app: 'Google Drive', full: 'Google Drive file',
        embeddable: segs[segs.length - 1] === 'preview' };
    }
    return base;
  }

  if (hostIn(host, EXCEL_HOSTS) || /\.(xlsx?|csv)$/i.test(u.pathname)) {
    return { ...base, kind: 'excel', name: 'Spreadsheet', app: 'Excel',
      full: 'Excel or SharePoint file',
      // Microsoft does have an embed form, but it is minted per file from the
      // Embed dialog and cannot be derived from a share link, so there is
      // nothing honest to offer here beyond opening a tab.
      embeddable: false };
  }

  return base;
}

/**
 * The URL to put in the iframe, or null when nothing should be framed.
 * Never the same object as the link we hand the "Open in ..." button: the
 * escape hatch has to keep the person's original URL, hash and all.
 */
export function sheetEmbedUrl(info) {
  if (!info || !info.embeddable) return null;
  let u;
  try { u = new URL(info.url); } catch { return null; }
  const tail = segments(u.pathname).pop() || '';

  if (info.kind === 'gsheet-pub') {
    // widget=true&headers=false is exactly what Google's own Embed tab emits.
    // Without it the frame repeats the published page's title bar and row
    // numbers, which on a 390px phone is most of the screen spent on chrome.
    if (tail === 'pubhtml') { u.searchParams.set('widget', 'true'); u.searchParams.set('headers', 'false'); }
    // /pub?output=csv|xlsx|pdf in a frame starts a download instead of drawing
    // anything. html is the one output that renders.
    else if (tail === 'pub') u.searchParams.set('output', 'html');
  } else if (info.kind === 'gform') {
    // Google's documented form-embed switch. It drops the account header and
    // the surrounding page so the questions start at the top of the frame.
    u.searchParams.set('embedded', 'true');
  }
  return u.href;
}

const TITLEY = /^[\w][\w \-.()&,']{1,60}$/;

/**
 * A label to pre-fill the add dialog with.
 *
 * There is no way to read a Google file's TITLE without the Drive API, so a
 * Google link gets its type name and the person types over it. gid is NOT used
 * here even though the URL often carries it: it is an internal sheet id, and
 * "Sheet (tab 87654321)" reads as a mistake rather than as a tab name.
 *
 * A filename is only borrowed when the URL really ends in one. onedrive's
 * /edit.aspx and SharePoint's /:x:/g/personal/... both end in a path segment
 * that is not a name, and labelling somebody's roster "Edit" is worse than
 * labelling it "Spreadsheet".
 */
export function sheetLabelFrom(info) {
  if (!info || !info.valid) return '';
  if (info.app && info.app.startsWith('Google')) return info.name;
  let last = '';
  try {
    last = segments(new URL(info.url).pathname).pop() || '';
  } catch { last = ''; }
  const named = /\.(xlsx?|csv|ods|numbers|pdf)$/i.test(last);
  const stem = last.replace(/\.[a-z0-9]{1,8}$/i, '').replace(/[_+%]+/g, ' ').trim();
  if (stem && TITLEY.test(stem) && (named || info.kind === 'link')) {
    return stem.charAt(0).toUpperCase() + stem.slice(1);
  }
  return info.kind === 'excel' ? 'Spreadsheet' : info.host || 'Link';
}
