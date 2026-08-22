// Telegram Topic One-Click — content script.
// Loaded into https://web.telegram.org/a/* at document_start.
//
// Detection signals (verified live in DevTools against the current WebA
// build — do not trust the upstream source for these; CSS-Modules class
// names hash differently per release, and a few "global" classes from the
// upstream codebase are not actually applied at runtime):
//
//   * .ListItem.Chat.selected-forum
//                                 — class on the main chat-list entry of
//                                   whichever forum group's panel is open.
//                                   This is the canonical "the topic
//                                   sidebar is visible" signal. Its inner
//                                   `<a class="ListItem-button">`'s href is
//                                   the bare forum chat id ("#<chatId>"),
//                                   which tells us *which* forum we're
//                                   dealing with — the browser URL hash is
//                                   unreliable because Telegram only
//                                   updates the URL when a *topic* is
//                                   opened, not when a forum group is
//                                   selected.
//
//                                   NOTE: a previous iteration gated on
//                                   `body.forum-panel-open`. That class is
//                                   never applied to <body> on the live
//                                   build; instead `forum-panel-open` ends
//                                   up on the main `.chat-list` element
//                                   itself. We deliberately don't depend on
//                                   that either, because `.selected-forum`
//                                   is sufficient and more direct.
//
//   * a.ListItem-button[href^="#<forumChatId>_"]
//                                 — topic rows inside the forum panel.
//                                   They live in a sibling `.chat-list`
//                                   that is *separate* from the main chat
//                                   list. Forum-panel-open is on the main
//                                   one; the panel one has just
//                                   `chat-list custom-scroll`.
//
//   * .MiddleHeader               — group/chat header island in
//                                   `.messages-layout` (`position: absolute`
//                                   since WebA #7059). The topic strip is
//                                   inserted after it and stacked below it.
//
//   * MiddleHeaderPanesIsland      — sibling rendered *after* MiddleHeader.
//                                   Pinned messages etc. We mark it
//                                   `[data-ttopic-panes-host]` and push it
//                                   below `#ttopic-strip`.
//
// Selectors below intentionally avoid CSS-Modules hashed classes (those
// look like `lrlHKC_D` / `Foo_bar_xyz12`). The ForumPanel root in the live
// build is currently `<div class="lrlHKC_D">` but we find it by walking up
// from the topic chat-list to the nearest `position: absolute` ancestor
// that still contains every topic anchor — so the volatile class name
// never enters our query. See docs/notes-selectors.md for details.

(() => {
  'use strict';

  // --- Constants ----------------------------------------------------------

  const STRIP_ID = 'ttopic-strip';
  const PANEL_MARK_ATTR = 'data-ttopic-panel';
  const BODY_ACTIVE_CLASS = 'ttopic-active';
  // Sentinel threadId for the "#All" chip. Active whenever the URL hash
  // is the bare forum chat id (no `_<threadId>` suffix) — i.e. the user
  // is viewing Telegram's "all messages" combined feed for this forum.
  const ALL_THREAD_ID = '__all__';
  const LOG_PREFIX = '[ttopic]';
  // Same 0.5rem gap Telegram uses between MiddleHeader and MiddleHeaderPanes
  // (MiddleHeaderPanes `top` calc and PANE_GAP_REM in useHeaderPane).
  const HEADER_PANE_GAP_REM = 0.5;

  // --- Tiny utilities -----------------------------------------------------

  const log = (...args) => {
    // eslint-disable-next-line no-console
    console.debug(LOG_PREFIX, ...args);
  };

  /** Parse `window.location.hash` into `{ chatId, threadId }` or null. */
  function parseHash() {
    const raw = (window.location.hash || '').replace(/^#/, '');
    if (!raw) return null;
    const parts = raw.split('_');
    const chatId = parts[0];
    if (!/^-?\d+$/.test(chatId)) return null;

    let threadId;
    if (parts.length >= 2) {
      const isType = ['thread', 'pinned', 'scheduled'].includes(parts[1]);
      threadId = isType ? undefined : parts[1];
    }
    return { chatId, threadId };
  }

  /**
   * Identify which forum panel is currently open and find its topic anchors.
   * Returns null if no forum panel is showing.
   */
  function findForumState() {
    // 1. The chat-list entry marked .selected-forum is the canonical
    //    "topic sidebar is visible" signal on the live build.
    const selected = document.querySelector(
      '.ListItem.Chat.selected-forum a.ListItem-button[href^="#"]',
    );
    if (!selected) return null;
    const href = selected.getAttribute('href') || '';
    const forumChatId = href.slice(1);
    // Must look like "-<digits>" (a group chat id).
    if (!/^-\d+$/.test(forumChatId)) return null;

    // 2. Topic anchors live inside the forum panel's own .chat-list and
    //    have hrefs of form "#<forumChatId>_<topicId>". The forum-group
    //    entry in the main chat list has href "#<forumChatId>" (no
    //    underscore), so the `_` in the prefix excludes it cleanly.
    //
    //    There's a brief race after the user clicks a forum group where
    //    .selected-forum has been applied but the panel's topic rows
    //    haven't mounted yet (~30ms in our measurements). In that case we
    //    bail and let the next MutationObserver tick re-detect.
    const topicAnchors = Array.from(
      document.querySelectorAll(
        `a.ListItem-button[href^="#${forumChatId}_"]`,
      ),
    );
    if (topicAnchors.length === 0) return null;

    // 3. The panel root is the nearest absolutely-positioned ancestor of
    //    the topic chat-list that still contains every topic anchor.
    //    Walking up by computed-position avoids depending on the panel
    //    div's hashed CSS-Modules class name.
    const chatList = topicAnchors[0].closest('.chat-list');
    let panelRoot = null;
    let node = chatList ? chatList.parentElement : topicAnchors[0].parentElement;
    while (node && node !== document.body) {
      const style = window.getComputedStyle(node);
      if (style.position === 'absolute') {
        if (topicAnchors.every((a) => node.contains(a))) {
          panelRoot = node;
          break;
        }
      }
      node = node.parentElement;
    }
    // Fallback: chat-list's parent. We do NOT mark the chat-list itself
    // because hiding it would also hide the topic anchors we proxy clicks
    // to. The fallback parent is almost always the panel root anyway.
    if (!panelRoot && chatList) panelRoot = chatList.parentElement;
    if (!panelRoot || panelRoot === document.body) return null;

    return { forumChatId, topicAnchors, panelRoot };
  }

  // --- Scraping -----------------------------------------------------------

  /**
   * @param {{ forumChatId: string, topicAnchors: HTMLAnchorElement[] }} state
   * @returns {Array<{ threadId: string, title: string, iconHTML: string, unread: number, anchor: HTMLAnchorElement }>}
   */
  function scrapeTopics(state) {
    const { forumChatId, topicAnchors } = state;
    const out = [];

    for (const anchor of topicAnchors) {
      const href = anchor.getAttribute('href') || '';
      const rest = href.slice(1 + forumChatId.length); // after "#<chatId>"
      const threadId = rest.startsWith('_') ? rest.slice(1).split('_')[0] : '';

      // Title — prefer .fullName.
      const fullNameEl = anchor.querySelector('.fullName');
      let title = (fullNameEl?.textContent || anchor.textContent || '').trim();
      title = title.replace(/\s+/g, ' ');
      if (title.length > 80) title = title.slice(0, 80) + '…';

      // Unread — best-effort number scrape.
      const badgeEl = anchor.querySelector(
        '[class*="ChatBadge" i], [class*="hat-badge" i], .ChatBadge, .badge',
      );
      let unread = 0;
      if (badgeEl) {
        const num = parseInt((badgeEl.textContent || '').trim(), 10);
        if (!Number.isNaN(num)) unread = num;
      }

      out.push({
        threadId,
        title: title || '(untitled)',
        unread,
        anchor,
      });
    }
    return out;
  }

  function topicsSignature(topics) {
    return topics
      .map((t) => `${t.threadId}|${t.title}|${t.unread}`)
      .join('\n');
  }

  // --- Auto-open ----------------------------------------------------------

  /**
   * Dispatch a full mouse-down → mouse-up → click sequence at the element.
   * WebA's ListItem wires its onClick via mousedown, so .click() alone
   * does not trigger Telegram's openThread action.
   *
   * Works on hidden elements too (we use this on the panel's ChatInfo
   * even when the panel root has `display: none`) — coordinates fall back
   * to (0,0) but Telegram's React handler doesn't care about coords.
   */
  function activateAnchor(anchor) {
    const rect = anchor.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 0,
      buttons: 1,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };
    anchor.dispatchEvent(new MouseEvent('mousedown', init));
    anchor.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
    anchor.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0 }));
  }

  /**
   * Trigger Telegram's "all messages" combined-feed view for the current
   * forum by simulating a click on the panel header's ChatInfo title
   * (the `<H3 class="fullName">` reachable via `.left-header .ChatInfo`).
   *
   * That click is the only known way on this WebA build to navigate to
   * the bare `#<chatId>` hash and have it stick; setting
   * `location.hash = '#<chatId>'` directly is rejected/normalized to
   * empty for non-bot forum supergroups (the ChatInfo handler routes
   * through Telegram's internal openChat action which DOES work).
   *
   * Side effect: opens the right column with Group Info — there's no
   * known way to suppress it programmatically (.click(), pointer events,
   * and Escape all fail to close it once opened). The user can dismiss
   * it manually; we accept it as the cost of getting an "all messages"
   * route at all on this build.
   *
   * Returns true if the click was dispatched, false if ChatInfo wasn't
   * found (panel not fully mounted yet).
   */
  function clickAllView(state) {
    if (!state.panelRoot) return false;
    const chatInfo = state.panelRoot.querySelector('.left-header .ChatInfo');
    if (!chatInfo) return false;
    activateAnchor(chatInfo);
    return true;
  }

  // --- Strip rendering ----------------------------------------------------

  let lastSignature = '';
  let stripResizeObserver = null;
  let observedStrip = null;

  function remPx() {
    return HEADER_PANE_GAP_REM * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
  }

  /**
   * Panes island is a later absolute sibling of .MiddleHeader (WebA #7059).
   * Skip our strip and the in-flow .Transition (message list).
   */
  function findHeaderPanesHost(header) {
    const layout = header?.closest('.messages-layout');
    if (!layout) return null;
    for (const node of layout.children) {
      if (node === header || node.id === STRIP_ID) continue;
      if (node.classList.contains('Transition')) continue;
      if (getComputedStyle(node).position === 'absolute') return node;
    }
    return null;
  }

  function syncStripLayout(strip) {
    const middleColumn = document.getElementById('MiddleColumn');
    if (!middleColumn) return;

    const header = document.querySelector('.MiddleHeader');
    const panesHost = findHeaderPanesHost(header);

    if (!strip?.isConnected) {
      middleColumn.style.removeProperty('--ttopic-strip-block-height');
      panesHost?.removeAttribute('data-ttopic-panes-host');
      return;
    }

    middleColumn.style.setProperty(
      '--ttopic-strip-block-height',
      `${strip.offsetHeight + remPx()}px`,
    );

    if (panesHost) panesHost.setAttribute('data-ttopic-panes-host', '1');
  }

  function observeStripLayout(strip) {
    syncStripLayout(strip);
    if (observedStrip === strip && stripResizeObserver) return;

    if (stripResizeObserver) stripResizeObserver.disconnect();
    observedStrip = strip;
    stripResizeObserver = new ResizeObserver(() => syncStripLayout(strip));
    stripResizeObserver.observe(strip);
  }

  function clearStripLayout() {
    if (stripResizeObserver) {
      stripResizeObserver.disconnect();
      stripResizeObserver = null;
    }
    observedStrip = null;
    document.getElementById('MiddleColumn')?.style.removeProperty('--ttopic-strip-block-height');
    document.querySelector('[data-ttopic-panes-host]')?.removeAttribute('data-ttopic-panes-host');
  }

  function ensureStrip() {
    let strip = document.getElementById(STRIP_ID);
    if (strip) return strip;
    strip = document.createElement('div');
    strip.id = STRIP_ID;
    strip.setAttribute('role', 'tablist');
    strip.setAttribute('aria-label', 'Topics');
    return strip;
  }

  function attachStrip(strip) {
    const header = document.querySelector('.MiddleHeader');
    const layout = header?.closest('.messages-layout');
    if (!header || !layout) {
      strip.remove();
      return false;
    }
    // Keep the strip in `.messages-layout` after `.MiddleHeader` so it
    // shares that column's containing block (both are position:absolute).
    if (strip.parentElement !== layout || header.nextElementSibling !== strip) {
      header.insertAdjacentElement('afterend', strip);
    }
    observeStripLayout(strip);
    return true;
  }

  function buildChip(topic, isActive, forumChatId) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'ttopic-chip' + (isActive ? ' ttopic-chip--active' : '');
    chip.setAttribute('role', 'tab');
    chip.setAttribute('aria-selected', isActive ? 'true' : 'false');
    chip.dataset.threadId = topic.threadId;
    chip.title = `#${topic.title}`;

    const label = document.createElement('span');
    label.className = 'ttopic-chip__label';
    label.textContent = `#${topic.title}`;
    chip.appendChild(label);

    if (topic.unread > 0) {
      const badge = document.createElement('span');
      badge.className = 'ttopic-chip__badge';
      badge.textContent = topic.unread > 99 ? '99+' : String(topic.unread);
      chip.appendChild(badge);
    }

    chip.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (topic.anchor && document.contains(topic.anchor)) {
        activateAnchor(topic.anchor);
      } else if (topic.threadId) {
        window.location.hash = `#${forumChatId}_${topic.threadId}`;
      }
    });

    return chip;
  }

  /**
   * Build the "#All" chip. Active when the URL hash is the bare forum
   * chat id (the all-messages combined feed). Clicking it triggers that
   * navigation by simulating a click on the panel's ChatInfo title — see
   * `clickAllView()`. No-op when already in the all view.
   *
   * The click handler reads the chip's live active class and re-finds
   * the forum state at click-time. We must NOT capture `isActive` or
   * `state` from the closure: chip elements are re-used across renders
   * (only the `--active` class is toggled), so closure values quickly
   * go stale and would either no-op forever or click into a stale panel.
   */
  function buildAllChip(isActive) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'ttopic-chip' + (isActive ? ' ttopic-chip--active' : '');
    chip.setAttribute('role', 'tab');
    chip.setAttribute('aria-selected', isActive ? 'true' : 'false');
    chip.dataset.threadId = ALL_THREAD_ID;
    chip.title = '#All — show all topics';

    const label = document.createElement('span');
    label.className = 'ttopic-chip__label';
    label.textContent = '#All';
    chip.appendChild(label);

    chip.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (chip.classList.contains('ttopic-chip--active')) return;
      const fresh = findForumState();
      if (fresh) clickAllView(fresh);
    });

    return chip;
  }

  function renderStrip(state, topics, hashInfo) {
    const strip = ensureStrip();
    if (!attachStrip(strip)) return;

    const sig = topicsSignature(topics);
    // The chip considered "active" is determined entirely by the URL
    // hash:
    //   - bare `#<forumChatId>`           → #All
    //   - `#<forumChatId>_<threadId>`     → that topic's chip
    // No separate "mode" state to track — the URL is the source of truth.
    const isAllView =
      hashInfo?.chatId === state.forumChatId && !hashInfo?.threadId;
    const activeId = isAllView
      ? ALL_THREAD_ID
      : hashInfo?.chatId === state.forumChatId
        ? hashInfo.threadId || ''
        : '';

    if (sig === lastSignature && strip.querySelector(`[data-thread-id="${ALL_THREAD_ID}"]`)) {
      // Topic set unchanged AND the #All chip is already present — just
      // update active flags. (The #All chip's presence guards against a
      // pre-#All-feature signature collision, in case the script is
      // reloaded into a page that already has an old strip.)
      for (const chip of strip.querySelectorAll('.ttopic-chip')) {
        const tid = chip.dataset.threadId || '';
        const isActive = tid === activeId;
        chip.classList.toggle('ttopic-chip--active', isActive);
        chip.setAttribute('aria-selected', isActive ? 'true' : 'false');
      }
    } else {
      strip.replaceChildren();
      strip.appendChild(buildAllChip(activeId === ALL_THREAD_ID));
      for (const t of topics) {
        strip.appendChild(buildChip(t, t.threadId === activeId, state.forumChatId));
      }
      lastSignature = sig;

      requestAnimationFrame(() => {
        const active = strip.querySelector('.ttopic-chip--active');
        if (active && typeof active.scrollIntoView === 'function') {
          active.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        }
      });
    }

    // Panel is ALWAYS hidden when our extension is active in this forum,
    // both in topic view and in all-messages view. The user explicitly
    // said: "with this extension we should never see a sidebar".
    if (state.panelRoot) state.panelRoot.setAttribute(PANEL_MARK_ATTR, '1');
    document.body.classList.add(BODY_ACTIVE_CLASS);
  }

  // --- Cleanup ------------------------------------------------------------

  /**
   * Remove our injected strip but DELIBERATELY leave `body.ttopic-active`
   * and `[data-ttopic-panel]` in place.
   *
   * When the user navigates away from a forum, Telegram plays a ~200ms
   * slide-out animation on the panel root before unmounting it (~400ms
   * total). If we strip `[data-ttopic-panel]` here, the panel un-hides
   * mid-animation and the user briefly sees it slide off-screen — the
   * "old topic sidebar blink" reported in QA.
   *
   * Leaving things on is safe:
   *
   *   - The marker is on a Telegram-owned element that gets removed
   *     from the DOM at the end of the slide-out, taking the marker
   *     with it. No stale state accumulates.
   *   - `body.ttopic-active` is harmless when no forum panel is open:
   *     its CSS rules are scoped to `[data-ttopic-panel]` and
   *     `.chat-list.forum-panel-open .info`, neither of which exist
   *     once Telegram has cleaned up.
   */
  function teardown() {
    const strip = document.getElementById(STRIP_ID);
    if (strip) strip.remove();
    clearStripLayout();
    lastSignature = '';
  }

  // --- Main loop ----------------------------------------------------------

  let scheduled = false;
  // We only auto-open when the *forum being shown in the panel* changes
  // (e.g. user just clicked a forum group). On the very first tick we
  // snapshot state without acting, so a page reload landing on a topic
  // (or on the all-messages view) doesn't get redirected.
  let initialized = false;
  let lastForumChatId = '';
  // Time-based debounce keeps the click→re-tick loop tight.
  const AUTO_OPEN_DEBOUNCE_MS = 1500;
  let lastAutoOpenAt = 0;
  let lastAutoOpenChat = '';

  function tick() {
    scheduled = false;
    try {
      const state = findForumState();
      const hashInfo = parseHash();

      if (!state) {
        teardown();
        lastForumChatId = '';
        initialized = true;
        return;
      }

      const topics = scrapeTopics(state);
      if (topics.length === 0) {
        teardown();
        lastForumChatId = state.forumChatId;
        initialized = true;
        return;
      }

      // Three URL states for "in this forum":
      //   - bare `#<forumChatId>`           → all-messages combined feed
      //   - `#<forumChatId>_<threadId>`     → a specific topic
      //   - anything else                   → not in this forum (yet)
      // Both the all-view and the topic-view should render our strip and
      // keep the panel hidden.
      const isInThisForumTopic =
        hashInfo?.chatId === state.forumChatId && Boolean(hashInfo?.threadId);
      const isInThisForumAll =
        hashInfo?.chatId === state.forumChatId && !hashInfo?.threadId;
      const isInThisForum = isInThisForumTopic || isInThisForumAll;

      const justChangedForum =
        initialized && lastForumChatId !== state.forumChatId;

      const now = Date.now();
      const debounced =
        lastAutoOpenChat === state.forumChatId &&
        now - lastAutoOpenAt < AUTO_OPEN_DEBOUNCE_MS;

      // Auto-open only triggers when the user has just clicked a forum
      // group (so the panel mounted for it) but the URL hasn't yet
      // navigated into that forum.
      //
      // Default destination is the first topic (typically General), NOT
      // the bare-hash all-messages view. Two reasons:
      //
      //   1. Speed. Telegram's all-messages combined feed makes a fresh
      //      multi-topic fetch and takes ~400-1500ms to render. Opening
      //      a single topic is essentially instant (~50ms).
      //   2. Visual consistency. The all-messages view renders messages
      //      smaller, with inline `# Topic` tags and a different reply
      //      highlight style. Forum topic views render messages exactly
      //      like every other chat (DM, channel, regular group).
      //
      // Users who want the all-messages view can click the `#All` chip
      // explicitly — that calls `clickAllView()` and accepts the cost.
      const shouldAutoOpen =
        !isInThisForum && justChangedForum && !debounced;

      if (shouldAutoOpen) {
        const target = topics[0];
        if (target?.anchor) {
          log('auto-open ->', state.forumChatId, target.title);
          // Dispatch the topic click immediately. Don't pre-render the
          // strip here: the OLD chat's `.MiddleHeader` is still in the
          // DOM and is what `attachStrip()` would attach to, so the
          // user would briefly see forum chips below the previous
          // chat's header — a visual mismatch worse than just waiting
          // for the new chat to render. With microtask scheduling
          // (see `scheduleTick`) the wait is ~120-150ms, short enough
          // that the strip can appear together with the new content
          // on the next tick after `hashchange`.
          activateAnchor(target.anchor);
          lastAutoOpenChat = state.forumChatId;
          lastAutoOpenAt = now;
          lastForumChatId = state.forumChatId;
          initialized = true;
          return; // click will trigger a re-tick via hashchange
        }
      }

      lastForumChatId = state.forumChatId;
      initialized = true;

      // Transient state: panel is detected for some forum, but URL is
      // still pointing at a previous (non-forum) chat — typically the
      // ~16-200ms window between `selected-forum` flipping and our
      // auto-open's hashchange landing. We must NOT render the strip
      // (it would attach to the wrong MiddleHeader), but we also must
      // not un-hide the panel: Telegram is mid-animation and any flash
      // is visible to the user. Keep panel hidden, drop strip only.
      if (!isInThisForum) {
        teardown();
        if (state.panelRoot) state.panelRoot.setAttribute(PANEL_MARK_ATTR, '1');
        document.body.classList.add(BODY_ACTIVE_CLASS);
        return;
      }

      renderStrip(state, topics, hashInfo);
    } catch (err) {
      log('tick error', err);
    }
  }

  function scheduleTick() {
    if (scheduled) return;
    scheduled = true;
    // requestAnimationFrame, not queueMicrotask.
    //
    // A previous attempt used `queueMicrotask(tick)` to shave the ~16ms
    // rAF latency off the auto-open path. That froze the page on the
    // live build: Telegram fires DOM mutations continuously (timer
    // ticks, animation frames, message rendering), each one queues an
    // observer microtask, each observer queues a tick microtask, each
    // tick can mutate DOM (strip class toggles, panel attribute
    // re-application) which fires the observer again — and microtasks
    // run to completion before the browser yields to paint, so the
    // event loop stalls visibly.
    //
    // rAF is bounded to ~60 ticks/sec and yields between frames, which
    // is the budget the rest of the page needs to stay responsive. The
    // ~16ms latency cost on auto-open is acceptable next to the
    // alternative of a frozen tab.
    requestAnimationFrame(tick);
  }

  // --- Bootstrap ----------------------------------------------------------

  function start() {
    log('content script loaded');
    scheduleTick();

    const observer = new MutationObserver(scheduleTick);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'href'],
    });

    window.addEventListener('hashchange', scheduleTick);
    window.addEventListener('popstate', scheduleTick);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
