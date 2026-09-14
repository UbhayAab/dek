// Feature registry.
//
// Every feature lives in its own file and exports `register(app)`. They are
// loaded dynamically and independently: one feature failing to load never takes
// the app down with it, and adding a feature means adding a filename here and
// nothing else. That is what lets features be built in parallel.
import { embed } from '../embed.js';

const FEATURES = [
  // The DMs tab's list surface; tabbar.js opens this panel when no conversation
  // is active. Early so the tab never races its registration.
  'dmlist',
  // The Activity tab. Takes over the core panel of the same id (replaces:true)
  // to add per-item read state, filters and a mark-read that does not open
  // anything. Early for the same reason dmlist is: the tab bar opens it.
  'activity',
  'polls',
  'events',
  'canvases',
  'topics',
  'forum',
  'later',
  'status',
  'profile',
  // A person as a page at #/u/<id>. The modal card answers "who just said that";
  // this is the staff directory entry, which is a different shape.
  'profilepage',
  'admin',
  // The organisation console. A page at #/admin, not a panel.
  'orgadmin',
  // The share sheet behind every "invite people" entry point. Not admin-only and
  // deliberately not skipped in embed: bringing a colleague in is a member's
  // action, not an operator's.
  'orgshare',
  // Finding the other servers. The most heard complaint was that people could
  // not see them; list_org_spaces has always returned them and there was
  // nowhere to press. After orgshare because both are about getting people in.
  'servers',
  'moderation',
  'integrations',
  'messageExtras',
  'onboarding',
  'roles',
  'snippets',
  'bookmarks',
  // Sheet access. bookmarks.js statically imports this one, so it is not
  // optional for the bar: loaded here in its own right for the /sheet command
  // and so a failure is reported under its own name.
  'sheets',
  'notifications',
  'shortcuts',
  // coordination (0055): what a volunteer coordinator does every week
  'ackloop',
  'forms',
  'tasks',
  // The cheap way in to the line above: a message that hands work out gets a
  // one-tap offer to become a task, parsed on this device with no model and no
  // round trip. Loaded after tasks so the panel it feeds already exists.
  'quicktask',
  // Progress updates, blockers and the queue of work nobody owns. After tasks
  // because it fills a slot tasks.js draws, and it needs migration 0101 - without
  // it every RPC returns "function not found" once and the feature switches
  // itself off rather than erroring on every card.
  'taskprogress',
  // Triage marks on a message: Important, High priority, Pending, Blocked, FYI.
  // After tasks, because the Task row in its menu routes to the real
  // create-a-task dialog rather than standing up a second, weaker one.
  'labels',
  // Applying for leave, approving it, and the ledger behind both. Booked once for
  // the organisation and shown per Space, so it needs the org layer under it.
  'leave',
  'orientation',
  'activityReport',
  // Labelled sidebar rows for the four panels above. Without it they are only
  // header buttons past the inline cap, and the channel bar's overflow is dead.
  'coordnav',
  // Voice rooms you can find on a phone, and the two admin jobs done most often.
  // Both are sidebar rows rather than header buttons, because a phone shows two
  // header buttons and hides fourteen.
  'voicerooms',
  'adminnav',
  // Screen sharing. The mechanics are in core next to the peer connections;
  // this is the button and the window you watch.
  'screenshare',
  'offline',
  // Ringing one person, the way a phone does. After voicerooms because the two
  // sit next to each other in the head of the app and this one inserts its bar
  // relative to the room bar; before uxfix, which decorates what is on screen.
  'calls',
  // Voice notes: MediaRecorder -> audio attachment. Field staff's most-used
  // gesture on WhatsApp; without it the record of what was said lives outside.
  'voicenotes',
  // Install, update, and being able to say which version you are on. Reported as
  // a team problem: people were stuck on old bundles with nothing to press.
  'version',
  // Late, so it is registered after the features whose errors it would catch.
  'errorreport',
  // Last on purpose: it re-registers a few core panels by id and decorates what
  // every other feature has already put on screen.
  'uxfix',
];

// Roadmap 9: operator surfaces, not panel surfaces. Embedded, #/admin was
// reachable straight off the hash bar inside somebody else's frame, orgadmin
// paints invite/password machinery, and integrations holds credentials - all
// three are the host dashboard's job, on the host's side of the glass. Skipped
// at load, so no route, header button or slash command for them ever exists.
const EMBED_SKIPPED = ['admin', 'orgadmin', 'integrations'];

export async function registerFeatures(app) {
  const loaded = [];
  await Promise.all(FEATURES.map(async (name) => {
    try {
      if (embed.active && EMBED_SKIPPED.includes(name)) return;
      const mod = await import(`./${name}.js`);
      if (typeof mod.register === 'function') {
        await mod.register(app);
        loaded.push(name);
      }
    } catch (e) {
      // A missing or broken feature module is a degraded app, not a dead one.
      if (!/Failed to fetch|not found|404/i.test(e.message || '')) {
        console.warn(`[dak] feature "${name}" failed to load:`, e);
      }
    }
  }));
  console.info('[dak] features loaded:', loaded.join(', ') || 'none');
  return loaded;
}
