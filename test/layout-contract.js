#!/usr/bin/env node
// Fails if the topic strip is laid out as if .MiddleHeader were still in-flow.
// WebA (2026-07+, #7059) makes header + panes position:absolute islands.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'src', 'overlay.css'), 'utf8');
const js = fs.readFileSync(path.join(root, 'src', 'content.js'), 'utf8');

const stripBlock = css.match(/#ttopic-strip\s*\{[^]*?\n\}/);
assert.ok(stripBlock, '#ttopic-strip rule missing');
assert.match(stripBlock[0], /position:\s*absolute/, 'strip must be an absolute island like .MiddleHeader');
assert.match(
  stripBlock[0],
  /--middle-header-height/,
  'strip top must clear the absolute group header',
);
assert.match(
  stripBlock[0],
  /--middle-header-gap/,
  'strip top must use Telegram’s header↔pane gap',
);

assert.match(
  css,
  /\[data-ttopic-panes-host\][^}]*--ttopic-strip-block-height/,
  'pinned panes must sit below the strip',
);

assert.match(
  css,
  /--message-list-top-inset:[^;]*--ttopic-strip-block-height/,
  'message list inset must include strip height',
);

assert.doesNotMatch(
  css,
  /\.first-message-date-group\s*\{\s*padding-top:\s*0/,
  'do not zero Telegram’s message top inset — header is out of flow now',
);

assert.match(
  js,
  /layout\.children|nextElementSibling/,
  'panes host is after .MiddleHeader, not before it',
);

assert.doesNotMatch(
  js,
  /previousElementSibling/,
  'old previous-sibling panes lookup is wrong after the island reorder',
);

console.log('layout-contract: ok');
