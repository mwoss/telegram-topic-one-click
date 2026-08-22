# WebA selector notes

Verified live in DevTools against the current `web.telegram.org/a/` build,
**not** the upstream `Ajaxy/telegram-tt` source. WebA uses CSS Modules so any
selector with a hashed suffix (e.g. `lrlHKC_D`, `ForumPanel_root_ab12c`) is
build-volatile and **must not** be relied on. The selectors below are global /
non-module classes that are stable across builds, plus a few content /
structural heuristics.

## Stable global classes

| Selector | Where | Use |
| --- | --- | --- |
| `.MiddleHeader` | Middle column chat header (`position: absolute` since WebA #7059) | Anchor for the topic strip — we insert `#ttopic-strip` immediately after it inside `.messages-layout` and stack the strip below this island. |
| `MiddleHeaderPanesIsland` | Sibling **after** `.MiddleHeader` (CSS-module root, hashed class) | Absolutely positioned bar for pinned messages, etc. Marked `[data-ttopic-panes-host]` and repositioned **below** `#ttopic-strip`. Sets `--middle-header-panes-height` on `#MiddleColumn`. |
| `.ListItem` / `.ListItem-button` | Every list row (chats, topics, menu items) | `.ListItem-button` is the inner clickable element. It's `<a>` when the row has an `href`, else `<div>`. On the live build, all chat / topic rows are `<a>`. |
| `.chat-list` | Scrollable list container | Used both by the main chat list and the forum panel's own chat-list. They are *separate* elements in the DOM. |
| `.fullName` | Chat / Topic entries | Holds the title text (`<h3 class="fullName">`). |
| `.selected-forum` | Class added to a `.ListItem.Chat` | Marks which forum group's panel is currently open. **This is the canonical "topic sidebar is visible" signal.** |
| `forum-panel-open` | Class added to the **main** `.chat-list` | Set when a forum panel is open. We do NOT depend on this — `.selected-forum` is enough and is on the more specific element. **Note:** an earlier iteration assumed this was on `<body>`. It is *not* — it ends up on the `.chat-list` element instead. Easy mistake; do not repeat it. |

## Topic icons

Topic rows render their icon in one of two ways depending on the topic:

- **General topic** uses `<i class="icon icon-hashtag general-forum-icon">`.
- **User-defined topics** use a colored "letter avatar" wrapper containing
  `<img class="...">` (the colored disc) + `<div class="topic-icon-letter">X</div>`
  (the letter overlay).

Our scrape picks the first matching of `.topic-icon-letter, .topic-icon,
.general-forum-icon, i.icon-hashtag, .CustomEmoji, img.emoji`, which works
for both shapes.

## URL hash routing

From observation:

- `#<chatId>` — chat with main thread (no topic selected for a forum group).
- `#<chatId>_<threadId>` — specific topic / thread.
- `#<chatId>_<threadId>_<type>` where `type` ∈ {`pinned`, `scheduled`}.
- For groups, `chatId` is `-<digits>` (e.g. `-1001500375277`).

**Important quirk:** Telegram's WebA only updates the URL hash when a
*topic* (or chat) is opened. **Clicking a forum-group entry to open the
topic sidebar does *not* update the URL.** This is why we cannot rely on
`location.hash` to know "the user just clicked into a forum group".

The `.selected-forum` class is the right signal instead: it appears within
~30 ms of clicking the forum entry, and disappears as soon as the user
navigates to a non-forum chat. Topic anchors (`a.ListItem-button[href^="#-…_"]`)
mount in the panel's `.chat-list` at the same time.

## Detection strategy

1. `document.querySelector('.ListItem.Chat.selected-forum a.ListItem-button[href^="#"]')`
   gives us the forum-group entry. Its href is `#<forumChatId>` (bare chat id).
2. `document.querySelectorAll(\`a.ListItem-button[href^="#<forumChatId>_"]\`)`
   gives us the topic anchors. The `_` after the chat id excludes the
   forum-group entry itself (whose href has no underscore).
3. The panel root is the nearest `position: absolute` ancestor of the topic
   `.chat-list` that contains every topic anchor. On the current build that's
   `<div class="lrlHKC_D">`, but the class name is hashed and we never query
   for it directly — we only walk up by computed position.

## Auto-open

We auto-open the first topic when:

- A forum panel is open (per detection above), AND
- The current URL is **not** already a topic in this forum (`#<forumChatId>_<threadId>`),
  AND
- Either:
  - the *previous* tick saw a different forum (or no forum), so we know the
    user just clicked this forum group (`justChangedForum`), or
  - the URL hash is the bare forum id (`isBareForumHash`, only happens on
    direct navigation / page reload to `#<forumChatId>`).

Auto-open works by dispatching a full `mousedown` → `mouseup` → `click`
sequence at the topic's `<a>` anchor. WebA's `ListItem` fires its real
`onClick` from `mousedown`, so a plain `.click()` does **not** trigger
Telegram's `openThread` action. The sequence is verified to flip the URL
hash and mount `.MiddleHeader` within ~350 ms.

## Hiding the original sidebar

Once the panel root is identified, we set `data-ttopic-panel="1"` on it and
add `body.ttopic-active`. Our CSS rule

```css
body.ttopic-active [data-ttopic-panel] { display: none !important; }
```

hides the panel without removing it from the DOM, so chip clicks can still
proxy to the underlying topic anchors (verified: `display: none` doesn't
prevent `dispatchEvent` from reaching the anchor's React-bound listeners).

## Chat list "wide and empty" trap

When a forum panel is open, Telegram applies these rules to every `.info`
(text content of a chat row) inside the main `.chat-list.forum-panel-open`:

```css
.chat-list.forum-panel-open .ListItem.Chat .info {
  opacity: 0;
  transform: translateX(-60px);
}
```

This is how Telegram visually compresses the chat list to "avatar only" so
the topic panel can sit on top of the now-empty text area. When **we** hide
the topic panel, that fade is no longer wanted — without overriding it, the
chat list looks wide and empty (rows are full width, but every row's text is
invisible and shifted off-screen). `overlay.css` undoes the fade with:

```css
body.ttopic-active .chat-list.forum-panel-open .info {
  opacity: 1 !important;
  transform: none !important;
}
```

The `!important` is required because Telegram's rule is in a CSS-Modules
stylesheet and our rule's selector specificity is otherwise lower.
