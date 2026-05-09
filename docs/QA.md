# QA checklist

The interactive QA below requires a real Chrome with a logged-in
`web.telegram.org/a/` session — it can't be run from CI. For each scenario
this doc records (1) what the code does and (2) what to verify in the
browser. If something doesn't match, file the discrepancy and I'll fix.

## How to test

1. Load the extension via `chrome://extensions` → Developer mode → **Load unpacked**.
2. Open <https://web.telegram.org/a/>.
3. Open Chrome DevTools console — the extension logs `[ttopic] ...` debug lines.

## Scenarios

### 1. Forum group with many topics

- **Code path**: `findForumPanel()` collects every `a.ListItem-button[href^="#<chatId>_"]`. No upper bound. `scrapeTopics()` iterates all of them. Each chip's label is rendered as `#<title>` (no icon). The strip is prefixed with a `#All` chip (sentinel `threadId="__all__"`). It uses `overflow-x: auto` and a soft mask on the right edge to hint at overflow. The active chip is `scrollIntoView`'d with `inline: 'center'`.
- **Verify**: open a forum with 10+ topics. The leftmost chip is `#All`, then `#<topic-name>` for each topic. You can horizontally scroll the strip. The active chip is centered when you switch.

### 1b. #All chip — opt-in all-messages combined feed

- **Code path**: the chip strip is prefixed with `#All` (sentinel `data-thread-id="__all__"`). It's the active chip whenever the URL hash is the bare forum chat id (`#<forumChatId>` with no `_<threadId>` suffix). Clicking `#All` simulates a click on the panel header's `.ChatInfo` element via `clickAllView()`; this is the only known way on this WebA build to navigate to the bare hash and have it stick (setting `location.hash = '#<chatId>'` directly is rejected by Telegram and clears the URL on non-bot forums). The panel root receives `[data-ttopic-panel]` in BOTH all-view and topic-view — the user explicitly asked to never see the native topic-list sidebar.
- **Why it's NOT the default-active chip on forum entry**: the all-messages combined feed makes a multi-topic fetch and is noticeably slower (~400ms+ even on a warm cache) than opening a single topic, AND it renders messages with smaller bubbles, inline `# Topic` tags, and a different reply highlight — visually inconsistent with how every other chat (DM, channel, regular group, single forum topic) renders. We auto-open `topics[0]` (typically `#General`) on forum entry instead, which is essentially instant and renders normally. `#All` is one click away when the user actually wants the combined view.
- **Side effect when opted in**: clicking `#All` opens the right column with Group Info. We have no way to suppress that programmatically (`.click()`, full pointer-event sequences, and Escape all fail to close it). Users can dismiss it manually. This is a known cost of getting an "all messages" route at all on this build for non-bot forums.
- **Verify**:
  - Click a forum group — URL becomes `#<forumChatId>_<firstTopicId>` (e.g. `#-100…_1`), `#General` is the active chip, middle column shows the General topic with normal Telegram rendering, panel hidden. Switch should feel instant.
  - Click `#All` — URL flips to bare `#<forumChatId>`, middle column shows the all-messages combined feed (with inline `# Topic` tags), `#All` becomes active, panel still hidden, right-column Group Info opens (acceptable side effect).
  - Click `#General` from `#All` — URL becomes `#<chatId>_1`, `#General` becomes active, panel still hidden.
  - Click `#All` while already active — no-op (early return on live `--active` class check).
  - Reload the page on `#<forumChatId>` (bare) — extension renders strip with `#All` active, panel hidden, no auto-redirect (initial-tick guard via `initialized`).
  - Reload the page on `#<forumChatId>_<threadId>` — extension renders strip with that topic active, panel hidden, no auto-redirect.

### 2. Forum group with few topics

- **Code path**: same code path; strip simply doesn't overflow.
- **Verify**: open a forum with 2-3 topics. Chips fit without scrolling, no fade mask visible at the edge (it still renders but has no content past it).

### 3. Switching between forum groups

- **Code path**: hash change → both `MutationObserver` and `hashchange` fire → `tick()` runs → `findForumPanel()` finds the new group's anchors → `scrapeTopics()` refreshes. `lastAutoOpenChat` is the *previous* chat id, so the debounce gate doesn't apply, and the new group's first topic is auto-opened.
- **Verify**: from inside forum A on a topic, click forum B in the chat list. You should land directly inside forum B's most-recent topic, with strip showing forum B's topics.

### 3a. Auto-open latency (forum-group click → first topic rendered)

- **Code path**: `scheduleTick()` queues `tick()` via `requestAnimationFrame`. When the user clicks a forum group, Telegram mounts the topic panel within ~20ms, our `MutationObserver` fires, we schedule a tick on the next animation frame (~16ms later), and the tick dispatches a synthetic click on `topics[0].anchor` (typically `#General`). Telegram then loads and renders the topic, which takes another ~100-300ms depending on cache state. End-to-end time-to-content is ~150-400ms, which is unavoidable: without the extension, clicking a forum group only mounts a DOM panel (no content fetch) so it feels "instant"; with auto-open enabled there is necessarily a topic load on top.
- **Why not `queueMicrotask`?**: that would skip the ~16ms rAF latency in theory, but in practice it froze the page. Telegram fires DOM mutations continuously (timer ticks, animation frames, message rendering); each mutation queues an observer microtask; each observer queues a tick microtask; each tick may mutate DOM (strip toggles, panel-marker re-application) which fires the observer again. Microtasks run to completion before the browser yields to paint, so the event loop stalled visibly. rAF is the right tool here because it's bounded to ~60 ticks/sec and yields between frames.
- **Verify**: from a single-person DM, click a forum group with topics. The middle column should populate with the first topic within ~150-400ms. There must be no visible "page is frozen" period; the rest of Telegram (chat list, animations) keeps moving while the topic loads.

### 4. Switching from a forum group to a non-forum chat (DM, channel, regular group)

- **Code path**: when the user navigates to a non-forum chat, Telegram itself removes the `.selected-forum` class from the forum-group entry and (a few hundred ms later, after a slide-out animation) unmounts the topic-panel root. Our `findForumState()` returns `null` immediately when `.selected-forum` flips, but `teardown()` only removes `#ttopic-strip` — it deliberately leaves `body.ttopic-active` and `[data-ttopic-panel]` in place. The marker rides along with the panel element until Telegram unmounts it; `body.ttopic-active` is harmless on non-forum chats (its CSS rules are scoped to elements that no longer exist).
- **Why we don't tear those down eagerly**: Telegram plays a ~200ms slide-out animation on the panel (`transform: translateX(...)` over time) before unmounting it at ~T+400ms. Removing `[data-ttopic-panel]` immediately would un-hide the panel mid-animation and the user would see the old topic sidebar slide off-screen — the "old topic sidebar blink" bug fixed in this iteration.
- **Verify**: switch from a forum to a DM. There must be NO flash/blink/slide of the old topic sidebar. The strip disappears, the new chat appears, and that's it.

### 4a. Different-forum switch

- **Code path**: clicking from forum A's topic into forum B mounts B's panel (or repurposes the slot). `tick()` detects state for B, marks B's panel root, renders B's strip. A's old panel marker (if A's element is still in DOM) stays on it until Telegram unmounts it.
- **Verify**: from a topic of forum A, click forum B in the chat list. You should land in B's #All view directly with no flash of A's panel sliding out.

### 4b. Chat list must look the same as for any non-forum chat

- **Code path**: when a forum panel is open, Telegram applies `opacity: 0` and `transform: translateX(-60px)` to every `.info` (text content) inside the main `.chat-list.forum-panel-open`, so the topic panel can visually take over. We hide the topic panel via `display: none`, but Telegram's fade rule still applies — without an override, the chat list becomes "wide and empty" (full-width rows but every row's text invisible & slid off-screen). `overlay.css` fixes this with `body.ttopic-active .chat-list.forum-panel-open .info { opacity: 1 !important; transform: none !important; }`.
- **Verify**: click a forum group — the left chat list should look identical to clicking any DM (full names, last-message previews, time stamps, badges all visible at their normal positions). No empty grey strip on the right side of the chat list, no avatar-only mode.

### 4c. Selected forum row must look identical to a selected DM

Telegram applies `.selected` to the active DM/channel/group and `.selected-forum` to a forum group whose topic panel is showing. On the live build these two classes get very different visual treatment, on the assumption that the topic sidebar would cover the forum row's "different" parts anyway. We hide the sidebar, so any divergence is visible side-by-side with regular selected chats. `overlay.css` patches every divergence we've found:

- **Background color**: `.selected` promotes `--background-color` to `var(--color-chat-active)` (purple); `.selected-forum` doesn't. Fixed by setting that variable on `.selected-forum` directly.
- **Topic-pill backgrounds inside the row's subtitle** (`# General`, `Wyjścia`): consume `--first-column-background-color`, which is set on a hashed-class ancestor (`.Ow6Ij9O5` at the time of writing) and shadows any value put on the row root. Fixed by re-setting that variable on every descendant of `.subtitle` (`.subtitle *`).
- **Text color of `.time`, `.last-message`, sender prefix**: `.selected` flips `--color-text-secondary`, `--color-text-meta`, `--color-text-meta-colored` to `#ffffff`; `.selected-forum` doesn't, so those texts stay gray on the purple bg. Fixed by setting all three variables to `#ffffff` on `.selected-forum`.
- **Hover/focus**: Telegram's default rule `.ListItem.focus { --background-color: var(--color-chat-hover); }` flips the row back to dark gray as soon as the cursor moves over it, making the selection look like it "drops". Fixed by re-asserting `--background-color: var(--color-chat-active)` on `.selected-forum.focus` and `.selected-forum:hover`.
- **`::before` accent bar**: only `.selected-forum` rows get a brighter-purple 5px×52px vertical bar at the right edge of the chat-list column (where the topic panel would dock). DM/channel `.selected` rows have nothing equivalent. Hidden via `content: none !important` on `.selected-forum::before`.

**Verify**: select a DM (e.g. Artek :3), then click a forum group (Jebac qualtrics). The forum row must look pixel-identical to a selected DM modulo the topic-pills inside the subtitle: same purple background, same white text everywhere (including time stamp and last-message preview), no extra accent bar at the row's edge. Hover over the row — the purple stays put, no flicker to gray.

### 4d. Chat-list search must remain visible inside a forum group

- **Code path**: when a forum panel mounts, Telegram applies `SearchInput--hidden` to the search input in `#LeftMainHeader`, which is just `pointer-events: none; opacity: 0;`. Native Telegram hides the chat-list search there because the topic-panel header has its own search input — but we hide the topic panel, so the search would disappear from the page entirely without an override. `overlay.css` re-shows it with `body.ttopic-active #LeftMainHeader .SearchInput--hidden { opacity: 1 !important; pointer-events: auto !important; }`.
- **Verify**: from a DM, note the search box is at the top of the chat list. Click a forum group — the search box must still be there at the same position, fully clickable. Type into it and confirm chat search results show up like normal.

### 5. Page reload while inside a topic

- **Code path**: script runs at `document_start`, waits for `DOMContentLoaded`, then sets up the observer. When Telegram boots and renders the forum panel, the observer fires `tick()`. The hash has `_<threadId>`, so `autoOpenIfNeeded()` is skipped. Strip renders.
- **Verify**: reload (Cmd-R) while on `#-100…_42`. Page should boot, strip appears below the chat header, no spurious topic switching.

### 6. Page reload while on bare `#<chatId>` (no topic selected)

- **Code path**: same as 5, except `autoOpenIfNeeded()` fires once and clicks the first topic.
- **Verify**: edit the URL to `#<chatId>` for a forum group and reload. The page should auto-redirect into the most-recent topic.

### 7. Browser back / forward

- **Code path**: `popstate` and `hashchange` both schedule a tick. Time-based 1.5s debounce on auto-open ensures Back into bare `#<chatId>` won't infinite-loop, but *will* re-redirect after the debounce elapses, so the user is never stranded with a hidden sidebar and an empty middle column.
- **Verify**: open a forum, switch between two topics, hit browser Back several times. Each Back should land on a topic (possibly with a brief flash through the bare-hash state).

### 8. Dark and light themes

- **Code path**: all colors in `overlay.css` use Telegram's CSS custom properties (`var(--color-background)`, `var(--color-text)`, `var(--color-borders)`, `var(--color-primary)`, `var(--color-gray)`) with hex fallbacks. They re-resolve when Telegram swaps themes.
- **Verify**: toggle Telegram's theme between dark and light. Strip background, chip border, and active-chip color should match the theme.

### 9. Loop / breakage protection

- **Code path**: every operation in `tick()` is wrapped in `try/catch` that logs but doesn't rethrow, so a selector breakage in a future Telegram release degrades to "extension does nothing" instead of breaking Telegram. The MutationObserver runs through `requestAnimationFrame`, so even pathological mutation storms cap at ~one tick per frame.
- **Verify**: open DevTools, watch CPU profile while opening a busy forum. The extension's frame contribution should stay tiny (<1ms typical).

## Known limitations

- **No real "All Messages" feed for non-bot forums**: WebA only exposes the all-messages route for bot-forums (which have an explicit `AllMessagesTopic` entry rendered as `href="#<chatId>"`). For regular forum supergroups, setting `location.hash = '#<chatId>'` is rejected/normalized by Telegram. Our `#All` chip therefore approximates mobile's "All" tab by un-hiding Telegram's native topic-list panel alongside our strip — the user sees per-topic previews on the left and whatever topic was auto-opened in the middle column. If a forum exposes a real `AllMessagesTopic` anchor, it will show up in the strip as one of the topic chips with whatever title Telegram uses (auto-open intentionally targets `topics[0]`, which is whatever the panel lists first).
- **Right-to-left languages**: the strip uses `flex` direction default; visual-direction support hasn't been smoke-tested.
