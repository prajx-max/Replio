const list = document.querySelector(
  '[data-testid="conversation-panel-messages"]',
);
let sequence = 0;
let switchedChats = 0;
let lastIncoming = null;
let lastOutgoing = null;
const publicIds = new URL(location.href).searchParams.has('publicIds');
const themeRows = new URL(location.href).searchParams.has('themeRows');
const remountTail = new URL(location.href).searchParams.has('remountTail');
const rewriteComposer = new URL(location.href).searchParams.has(
  'rewriteComposer',
);
document.getElementById('hold-send').onchange = (event) => {
  document.getElementById('send').disabled = event.target.checked;
};
if (rewriteComposer)
  document.getElementById('main').addEventListener('input', (event) => {
    const editor = event.target.closest('[contenteditable="true"]');
    if (!editor) return;
    globalThis.queueMicrotask(() => {
      if (!editor.isConnected) return;
      const replacement = editor.cloneNode(true);
      const textNodes = document.createTreeWalker(replacement, 4);
      while (textNodes.nextNode())
        textNodes.currentNode.textContent =
          textNodes.currentNode.textContent.replaceAll(' ', '\u00a0');
      editor.replaceWith(replacement);
    });
  });
if (themeRows)
  document
    .querySelector('#main header [data-chat-id]')
    .removeAttribute('data-chat-id');
function themeWrap(node, direction, id) {
  if (!themeRows) return;
  const main = document.getElementById('main');
  main.style.setProperty('--incoming-background', '#242626');
  main.style.setProperty('--outgoing-background', '#144d37');
  node.className = 'opaque-message-row';
  node.dataset.id = id.toString(16).padStart(32, '0');
  node.dataset.testid = `conv-msg-${id}`;
  const container = document.createElement('div');
  container.dataset.testid = 'msg-container';
  const bubble = document.createElement('div');
  bubble.style.backgroundColor = `var(--${direction === 'out' ? 'outgoing' : 'incoming'}-background)`;
  bubble.append(...node.childNodes);
  container.append(bubble);
  node.append(container);
}
function directionId(direction, id) {
  return `${direction === 'out' ? 'true' : 'false'}_fixture@lid_${id}`;
}
if (publicIds || themeRows) {
  for (const node of list.children) {
    node.setAttribute('data-id', directionId('in', 'baseline'));
    node.className = 'opaque-message-row';
    themeWrap(node, 'in', ++sequence);
  }
}
function add(direction, text) {
  const node = document.createElement('div');
  node.className = publicIds ? 'opaque-message-row' : `message-${direction}`;
  node.dataset.id = publicIds
    ? directionId(direction, ++sequence)
    : `fixture-${++sequence}`;
  const span = document.createElement('span');
  span.className = 'selectable-text copyable-text';
  span.textContent = text;
  node.append(span);
  themeWrap(node, direction, sequence);
  list.append(node);
  if (direction === 'in') lastIncoming = node;
  else lastOutgoing = node;
}
document.getElementById('incoming').onclick = () => {
  if (remountTail && lastOutgoing && lastOutgoing === list.lastElementChild) {
    const replacement = lastOutgoing.cloneNode(true);
    lastOutgoing.replaceWith(replacement);
    lastOutgoing = replacement;
  }
  add('in', document.getElementById('question').value);
};
document.getElementById('outgoing').onclick = () =>
  add('out', 'This is an outgoing message.');
document.getElementById('duplicate').onclick = () => {
  const node =
    lastIncoming && list.contains(lastIncoming)
      ? lastIncoming
      : list.querySelector(
          themeRows
            ? '[data-testid^="conv-msg-"]:last-child'
            : publicIds
              ? '[data-id^="false_"]:last-child'
              : '.message-in:last-child',
        );
  if (node) list.append(node.cloneNode(true));
};
document.getElementById('history').onclick = () => {
  const node = document.createElement('div');
  node.className = publicIds ? 'opaque-message-row' : 'message-in';
  node.dataset.id = publicIds
    ? directionId('in', `older-${++sequence}`)
    : `older-${++sequence}`;
  node.textContent = 'Historical content, not a new message.';
  themeWrap(node, 'in', sequence);
  list.prepend(node);
};
document.getElementById('switch').onclick = () => {
  const title = document.querySelector('#main header [title]');
  const suffix = String.fromCharCode(66 + switchedChats++);
  if (!themeRows)
    title.setAttribute('data-chat-id', `fixture-chat-${suffix.toLowerCase()}`);
  title.setAttribute('title', `Fixture customer ${suffix}`);
  title.textContent = `Fixture customer ${suffix}`;
  document.querySelector('[contenteditable="true"]').textContent = '';
  list.replaceChildren();
  add('in', 'History in the second chat.');
};
document.getElementById('send').onclick = () => {
  const composer = document.querySelector('[contenteditable="true"]');
  if (!composer.innerText.trim()) return;
  add('out', composer.innerText);
  composer.textContent = '';
  composer.dispatchEvent(
    new globalThis.InputEvent('input', {
      bubbles: true,
      inputType: 'deleteContentBackward',
    }),
  );
  const output = document.getElementById('sent');
  output.textContent = String(Number(output.textContent) + 1);
};

if (new URL(location.href).searchParams.has('inbox')) {
  let pane = document.createElement('div');
  const splitUnreadRender = new URL(location.href).searchParams.has(
    'splitUnreadRender',
  );
  pane.id = 'pane-side';
  document.querySelector('aside').append(pane);
  const initialUnread = ['Already unread', 'Waiting since yesterday'];
  const names = [...initialUnread, 'Lina', 'Omar'];
  const unread = new Set(initialUnread);
  let selectedChat = '';
  function unreadBadge() {
    const badge = document.createElement('span');
    badge.setAttribute('aria-hidden', 'true');
    badge.style.backgroundColor = '#25d366';
    badge.style.color = '#111b21';
    badge.innerHTML = '<span>1</span>';
    badge.className = 'fixture-unread-badge';
    return badge;
  }
  function renderRow(name) {
    const row = document.createElement('div');
    row.setAttribute('role', 'listitem');
    row.setAttribute('aria-selected', String(selectedChat === name));
    const title = document.createElement('span');
    title.title = name;
    title.textContent = name;
    // A human-readable sidebar clock, without a datetime attribute or test ID.
    const clock = document.createElement('span');
    clock.textContent =
      name === 'Already unread'
        ? 'Yesterday'
        : new Date().toLocaleTimeString('en-GB', {
            hour: '2-digit',
            minute: '2-digit',
          });
    row.append(title, clock);
    // Native-style decorative badge: no stable test ID or English accessible
    // label. The adapter must match both public theme colors before reading it.
    row.style.setProperty('--unread-marker-background', '#25d366');
    row.style.setProperty('--unread-marker-text', '#111b21');
    if (unread.has(name)) row.append(unreadBadge());
    row.onclick = () => {
      selectedChat = name;
      unread.delete(name);
      pane
        .querySelector('[aria-selected="true"]')
        ?.setAttribute('aria-selected', 'false');
      row.setAttribute('aria-selected', 'true');
      const header = document.querySelector('#main header [title]');
      header.removeAttribute('data-chat-id');
      header.title = name;
      header.textContent = name;
      list.replaceChildren();
      add('in', 'Earlier private history');
      const divider = document.createElement('div');
      divider.textContent = '1 unread message';
      list.append(divider);
      add('in', name + ' asks for business hours');
      row.querySelector('.fixture-unread-badge')?.remove();
    };
    return row;
  }
  pane.replaceChildren(...names.map(renderRow));
  const arrive = document.createElement('button');
  arrive.textContent = 'Receive unread messages in two chats';
  arrive.onclick = () => {
    unread.add('Lina');
    unread.add('Omar');
    if (splitUnreadRender) {
      const moving = [...pane.children].filter((row) =>
        ['Lina', 'Omar'].includes(row.querySelector('[title]')?.title),
      );
      for (const row of moving) row.remove();
      // Removal and reattachment occur in distinct observer deliveries.
      globalThis.setTimeout(() => {
        pane.prepend(...moving);
        for (const row of moving) {
          const title = row.querySelector('[title]');
          title?.setAttribute('title', title.title);
          row.append(unreadBadge());
        }
      }, 75);
      return;
    }
    // A virtualized list recreates its visible rows as the two arrivals move
    // up. The unchanged pre-existing unread chat also gets a new DOM node.
    pane.replaceChildren(...['Lina', 'Omar', ...initialUnread].map(renderRow));
  };
  const redraw = document.createElement('button');
  redraw.textContent = 'Rerender queued chat rows';
  redraw.onclick = () => pane.replaceChildren(...names.map(renderRow));
  const remount = document.createElement('button');
  remount.textContent = 'Remount the chat list';
  remount.onclick = () => {
    const replacement = document.createElement('div');
    replacement.id = pane.id;
    replacement.append(...pane.children);
    pane.replaceWith(replacement);
    pane = replacement;
  };
  pane.after(arrive, redraw, remount);
  const receipts = document.createElement('ol');
  receipts.id = 'inbox-replies';
  pane.after(receipts);
  document.getElementById('send').addEventListener('click', () => {
    const selected = pane.querySelector('[aria-selected="true"] span[title]');
    if (selected && lastOutgoing) {
      const entry = document.createElement('li');
      entry.textContent = selected.title + ' — ' + lastOutgoing.textContent;
      receipts.append(entry);
    }
  });
}
