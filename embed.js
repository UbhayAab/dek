// Dek embed loader. This is the file a dashboard includes; everything else in
// this repo is the app it loads.
//
//   <script src="https://dek.example.com/embed.js"></script>
//   <script>
//     const dek = Dek.mount({
//       el: '#chat-dock',
//       space: 'Tech',
//       auth: async () => (await fetch('/api/dek-token')).json(),
//     });
//     dek.on('unread', ({ total }) => setBadge(total));
//   </script>
//
// No build step, no dependencies, no globals beyond `Dek`. It is deliberately
// small and boring: a host page will not adopt an embed that ships a framework,
// and every kilobyte here is spent before the dashboard's own work starts.
//
// WHAT IT ACTUALLY DOES
//   - builds the iframe, naming the host's own origin in the src so the app can
//     check it against its allowlist and reply to exactly one place
//   - waits for the app to say `ready`, then fetches credentials from the host
//     and hands them over
//   - forwards events back to the host as ordinary callbacks
//
// The auth callback is the whole security design. It runs on the HOST's page and
// is expected to call the HOST's backend, which is the only party that may hold a
// signing secret. Nothing in this file ever sees one.
(function () {
  'use strict';

  var PROTO = 'dek';
  // Rewritten at deploy time if the app is served from somewhere else. Derived
  // from this script's own src so the common case needs no configuration: the
  // loader and the app ship together.
  var SELF = (document.currentScript && document.currentScript.src) || '';
  var APP_BASE = SELF ? SELF.replace(/\/embed\.js(\?.*)?$/, '/') : '/';

  function qs(obj) {
    var out = [];
    for (var k in obj) {
      if (obj[k] === null || obj[k] === undefined || obj[k] === '') continue;
      out.push(encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]));
    }
    return out.join('&');
  }

  function mount(opts) {
    opts = opts || {};
    var host =
      typeof opts.el === 'string' ? document.querySelector(opts.el) : opts.el;
    if (!host) throw new Error('Dek.mount: no element matching ' + opts.el);

    var listeners = {};
    var frame = document.createElement('iframe');
    var ready = false;
    var destroyed = false;

    var src =
      (opts.app || APP_BASE) +
      'index.html?' +
      qs({
        embed: '1',
        // The app replies to this and only this. It is the host's own origin, so
        // it is not a secret and not a claim of identity - the app checks it
        // against its allowlist before believing any of it.
        host: window.location.origin,
        space: opts.space,
        channel: opts.channel,
        chrome: opts.chrome || 'minimal',
        theme: opts.theme,
      });

    frame.src = src;
    frame.title = opts.title || 'Team chat';
    frame.setAttribute('loading', opts.eager === false ? 'lazy' : 'eager');
    // Without these the panel looks fine and then fails at the exact moment
    // somebody tries to use it: no clipboard on "copy link", no microphone in a
    // voice room, no full screen on an image. Each is opt-in per frame and there
    // is no way for the frame to grant itself one.
    // Exactly what the app uses, and nothing else. `camera` and
    // `display-capture` were in here and are used NOWHERE in the app: voice
    // rooms ask for {audio:true, video:false} and getDisplayMedia is never
    // called. Delegating a permission the app cannot use is pure downside - it
    // is a capability sitting there for any script that manages to run in the
    // frame, on a page that belongs to somebody else.
    frame.setAttribute(
      'allow',
      'clipboard-write; microphone; fullscreen; autoplay; web-share'
    );
    // Without this every request the panel makes - including every Supabase
    // call - carries the customer's internal dashboard URL in the Referer
    // header, to third parties, forever. The dashboard's own URLs frequently
    // name the tenant, and sometimes the record being looked at.
    frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    frame.style.cssText =
      'border:0;width:100%;height:100%;display:block;background:transparent;' +
      (opts.style || '');
    host.appendChild(frame);

    function post(type, data) {
      if (destroyed) return;
      var msg = { v: 1 };
      msg[PROTO] = type;
      for (var k in data || {}) msg[k] = data[k];
      // Targeted at the app's exact origin, never '*'. This message can carry a
      // session; a wildcard target would hand it to whatever happens to be in
      // the frame if the src were ever changed underneath us.
      frame.contentWindow &&
        frame.contentWindow.postMessage(msg, new URL(src, location.href).origin);
    }

    function emit(name, payload) {
      (listeners[name] || []).forEach(function (fn) {
        try {
          fn(payload);
        } catch (e) {
          console.error('[dek] listener for "' + name + '" threw', e);
        }
      });
    }

    function handOver() {
      if (!opts.auth) {
        // No auth callback: the person signs in inside the panel. Legitimate for
        // a public or demo embed, wrong for a dashboard, so say so once.
        console.warn(
          '[dek] mounted with no auth callback - the panel will ask for a password'
        );
        return;
      }
      Promise.resolve()
        .then(function () {
          return opts.auth();
        })
        .then(function (cred) {
          if (!cred) throw new Error('auth callback returned nothing');
          // Either shape is accepted. `handoff` is the one to prefer: a
          // single-use token your backend got from Dek, which this browser
          // spends. `session` means your backend minted the Supabase session
          // itself and is passing both tokens through.
          post('auth', cred.handoff ? { handoff: cred.handoff } : { session: cred });
        })
        .catch(function (e) {
          emit('error', { where: 'auth', message: String((e && e.message) || e) });
          console.error('[dek] could not get credentials for the panel', e);
        });
    }

    function onMessage(ev) {
      if (destroyed) return;
      if (ev.source !== frame.contentWindow) return;
      if (ev.origin !== new URL(src, location.href).origin) return;
      var msg = ev.data;
      if (!msg || typeof msg !== 'object' || typeof msg[PROTO] !== 'string') return;

      if (msg[PROTO] === 'ready') {
        ready = true;
        emit('ready', msg);
        if (msg.needsAuth) handOver();
        return;
      }
      emit(msg[PROTO], msg);
    }
    window.addEventListener('message', onMessage);

    return {
      frame: frame,
      on: function (name, fn) {
        (listeners[name] || (listeners[name] = [])).push(fn);
        return this;
      },
      off: function (name, fn) {
        listeners[name] = (listeners[name] || []).filter(function (f) {
          return f !== fn;
        });
        return this;
      },
      // Open a channel by id or name. Safe to call before `ready`: it is dropped
      // rather than queued, because a navigation the person did not just ask for
      // arriving three seconds late is worse than one that did not happen.
      navigate: function (to) {
        if (ready) post('navigate', typeof to === 'string' ? { channel: to } : to);
        return this;
      },
      // Re-run the auth callback. Call this when the host's own session changes,
      // so the panel follows the dashboard rather than holding a stale identity.
      identify: function () {
        handOver();
        return this;
      },
      signOut: function () {
        post('signout', {});
        return this;
      },
      // Tell the panel it was just shown or hidden by the dashboard. A CSS
      // collapse is invisible to the iframe: visibility events inside it
      // reflect the top-level browser tab, not your layout, so a panel that
      // sat collapsed for an hour has a realtime socket that still says
      // "joined" while carrying no frames. Call visible() from whatever shows
      // the panel again; it force-rebuilds the socket and refreshes unread.
      visible: function () {
        post('visible', {});
        return this;
      },
      hidden: function () {
        post('hidden', {});
        return this;
      },
      setTheme: function (theme) {
        post('theme', { theme: theme });
        return this;
      },
      // CSS custom properties only, so the panel can take the dashboard's brand
      // colours without the dashboard being able to restyle it into something
      // that misrepresents what it is.
      setTokens: function (tokens) {
        post('tokens', { tokens: tokens });
        return this;
      },
      destroy: function () {
        destroyed = true;
        window.removeEventListener('message', onMessage);
        frame.remove();
      },
    };
  }

  window.Dek = { mount: mount, version: 2 };
  // One-line compat for dashboards that included this file under its old name.
  // New code uses window.Dek. Remove no earlier than 2027-03.
  window.Soop = window.Dek;
})();
