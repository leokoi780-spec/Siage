(() => {
  const CHUNK_SIZE = 16 * 1024; // 16KB per chunk, base64-encoded on the wire
  const MAX_FILE_SIZE = 300 * 1024 * 1024; // keep in sync with server.js
  const MAX_RECONNECT_ATTEMPTS = 6;
  const MAX_TEXTAREA_HEIGHT = 140; // px — composer grows to this, then scrolls

  // crypto.randomUUID only exists in "secure contexts" (HTTPS, or localhost).
  // Testing over a plain http://<lan-ip>:3000 URL — exactly what the README
  // suggests for trying this out on a phone — is NOT a secure context, so
  // relying on crypto.randomUUID alone breaks room creation on every other
  // device on the network. Fall back to a manual v4-style id in that case.
  function makeId() {
    if (window.crypto?.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // ---------- Connection ----------
  // Talks to the server over a plain WebSocket using a small JSON protocol:
  //   { type: 'chat-message', text: '...' }                — fire-and-forget
  //   { type: 'create-room', reqId, name }                  — expects an ack
  // The server replies to reqId-bearing messages with { type: 'ack', reqId, ... }.
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const pending = new Map(); // reqId -> resolve
  const outgoingRejected = new Set(); // fileIds the server refused to relay
  let socket = null;
  let connected = false;
  let roomCode = '';
  let currentName = '';
  let reconnectAttempts = 0;
  let reconnectTimer = null;

  function request(type, payload = {}) {
    return new Promise((resolve) => {
      const reqId = makeId();
      pending.set(reqId, resolve);
      socket.send(JSON.stringify({ type, reqId, ...payload }));
    });
  }

  function send(type, payload = {}) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type, ...payload }));
  }

  // ---------- Elements ----------
  const landingScreen = document.getElementById('landing');
  const roomScreen = document.getElementById('room');
  const landingError = document.getElementById('landing-error');

  const createNameInput = document.getElementById('create-name');
  const createBtn = document.getElementById('create-btn');
  const joinNameInput = document.getElementById('join-name');
  const joinCodeInput = document.getElementById('join-code');
  const joinBtn = document.getElementById('join-btn');

  const roomCodeBtn = document.getElementById('room-code-btn');
  const roomMembersEl = document.getElementById('room-members');
  const connectionDot = document.getElementById('connection-dot');
  const leaveBtn = document.getElementById('leave-btn');
  const messagesEl = document.getElementById('messages');
  const typingIndicator = document.getElementById('typing-indicator');
  const connectionBanner = document.getElementById('connection-banner');

  const composer = document.getElementById('composer');
  const textInput = document.getElementById('text-input');
  const attachBtn = document.getElementById('attach-btn');
  const fileInput = document.getElementById('file-input');
  const dropOverlay = document.getElementById('drop-overlay');

  const createBtnLabel = createBtn.textContent;
  const joinBtnLabel = joinBtn.textContent;

  let typingTimeout = null;

  // In-flight incoming file transfers: fileId -> { chunks: [], received, total, meta, wrap }
  const incoming = new Map();

  // ---------- Small utilities ----------
  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let val = bytes;
    while (val >= 1024 && i < units.length - 1) {
      val /= 1024;
      i++;
    }
    return `${val.toFixed(val >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function formatTime(ts) {
    try {
      return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    } catch {
      return '';
    }
  }

  // Deterministic, pleasant-enough color per name so people are visually
  // distinguishable in a room without anyone picking an avatar.
  function nameColor(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    return `hsl(${hash % 360}, 62%, 68%)`;
  }

  // Copies text to the clipboard, with a manual fallback for browsers/
  // contexts (e.g. plain-http LAN testing) where the async Clipboard API
  // isn't available.
  function copyToClipboard(text, onDone) {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(onDone, () => window.prompt('Copy:', text));
    } else {
      window.prompt('Copy:', text);
      onDone?.();
    }
  }

  function showError(msg) {
    landingError.textContent = msg;
    landingError.hidden = false;
  }

  function clearError() {
    landingError.hidden = true;
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function setConnectionDot(state, title) {
    if (!connectionDot) return;
    connectionDot.className = `connection-dot connection-dot--${state}`;
    connectionDot.title = title;
  }

  function setConnectionBanner(state, text) {
    connectionBanner.hidden = false;
    connectionBanner.textContent = text;
    connectionBanner.className = `connection-banner connection-banner--${state}`;
  }

  function hideConnectionBanner() {
    connectionBanner.hidden = true;
  }

  // ---------- Message rendering ----------
  function addSystemMessage(text) {
    const el = document.createElement('div');
    el.className = 'msg msg-system';
    el.textContent = text;
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  function copyIconSvg() {
    return `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>`;
  }

  function checkIconSvg() {
    return `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M4 12l6 6L20 6"/></svg>`;
  }

  function addCopyButton(wrap, getText) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'msg-copy';
    btn.setAttribute('aria-label', 'Copy message');
    btn.innerHTML = copyIconSvg();
    btn.addEventListener('click', () => {
      copyToClipboard(getText(), () => {
        btn.classList.add('copied');
        btn.innerHTML = checkIconSvg();
        setTimeout(() => {
          btn.classList.remove('copied');
          btn.innerHTML = copyIconSvg();
        }, 1200);
      });
    });
    wrap.appendChild(btn);
  }

  function addTextMessage({ text, name, mine, ts }) {
    const wrap = document.createElement('div');
    wrap.className = `msg msg-text ${mine ? 'msg-me' : 'msg-them'}`;
    wrap.title = formatTime(ts || Date.now());
    if (!mine) {
      const meta = document.createElement('div');
      meta.className = 'msg-meta';
      meta.textContent = name;
      meta.style.color = nameColor(name);
      wrap.appendChild(meta);
    }
    const body = document.createElement('div');
    body.className = 'msg-body';
    body.textContent = text; // textContent + CSS white-space:pre-wrap preserves
                              // line breaks/spacing exactly as typed or pasted,
                              // with no HTML-injection risk.
    wrap.appendChild(body);
    addCopyButton(wrap, () => text);
    messagesEl.appendChild(wrap);
    scrollToBottom();
  }

  function fileIconSvg() {
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 3v5a1 1 0 0 0 1 1h5"/><path d="M6 3h8l6 6v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/></svg>`;
  }

  function addFileMessage({ name, size, mine, fileId, from }) {
    const wrap = document.createElement('div');
    wrap.className = `msg ${mine ? 'msg-me' : 'msg-them'}`;
    wrap.dataset.fileId = fileId;

    if (!mine) {
      const meta = document.createElement('div');
      meta.className = 'msg-meta';
      meta.textContent = from || 'them';
      meta.style.color = nameColor(from || 'them');
      wrap.appendChild(meta);
    }

    const card = document.createElement('div');
    card.className = 'file-card';
    card.innerHTML = `
      <div class="file-icon">${fileIconSvg()}</div>
      <div class="file-info">
        <div class="file-name"></div>
        <div class="file-size"></div>
        <div class="file-progress"><div class="file-progress-bar"></div></div>
      </div>
    `;
    card.querySelector('.file-name').textContent = name;
    card.querySelector('.file-size').textContent = formatBytes(size);
    wrap.appendChild(card);
    messagesEl.appendChild(wrap);
    scrollToBottom();
    return wrap;
  }

  function setFileProgress(wrap, pct) {
    const bar = wrap.querySelector('.file-progress-bar');
    if (bar) bar.style.width = `${Math.min(100, pct)}%`;
  }

  function finishFileMessage(wrap, blobUrl) {
    const progress = wrap.querySelector('.file-progress');
    if (progress) progress.remove();
    const info = wrap.querySelector('.file-info');
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = wrap.querySelector('.file-name').textContent;
    link.className = 'file-download';
    link.textContent = 'Download';
    info.appendChild(link);
  }

  function markFileFailed(wrap, reason) {
    if (!wrap) return;
    const progress = wrap.querySelector('.file-progress');
    if (progress) progress.remove();
    const info = wrap.querySelector('.file-info');
    const note = document.createElement('div');
    note.className = 'file-error';
    note.textContent = reason || "This file couldn't be sent.";
    info.appendChild(note);
  }

  function updateMembers(members) {
    if (!members) return;
    roomMembersEl.innerHTML = '';
    if (members.length === 1) {
      roomMembersEl.textContent = 'Just you, waiting for someone to join';
      return;
    }
    const count = document.createElement('span');
    count.textContent = `${members.length} in this room \u00b7 `;
    roomMembersEl.appendChild(count);
    members.forEach((name, i) => {
      const dot = document.createElement('span');
      dot.className = 'member-dot';
      dot.style.background = nameColor(name);
      roomMembersEl.appendChild(dot);
      const nameEl = document.createElement('span');
      nameEl.textContent = name + (i < members.length - 1 ? ', ' : '');
      roomMembersEl.appendChild(nameEl);
    });
  }

  function enterRoom(code, name, members) {
    roomCode = code;
    currentName = name;
    roomCodeBtn.textContent = code;
    updateMembers(members);
    landingScreen.hidden = true;
    roomScreen.hidden = false;
    textInput.focus();
  }

  // ---------- Connection lifecycle ----------
  function connectSocket() {
    socket = new WebSocket(`${wsProtocol}//${location.host}`);
    socket.addEventListener('open', handleOpen);
    socket.addEventListener('close', handleClose);
    socket.addEventListener('message', handleMessage);
  }

  async function handleOpen() {
    connected = true;
    reconnectAttempts = 0;

    if (!roomScreen.hidden) {
      // We were already in a room — this connection came back after a drop.
      // Try to silently rejoin under the same code and name.
      setConnectionBanner('reconnecting', 'Reconnected \u2014 rejoining the room\u2026');
      const res = await request('join-room', { code: roomCode, name: currentName });
      if (!res.ok) {
        setConnectionDot('lost', 'Disconnected');
        setConnectionBanner('lost', res.error || 'That room is gone. Reload the page to start over.');
        return;
      }
      setConnectionDot('connected', 'Connected');
      hideConnectionBanner();
      updateMembers(res.members);
      addSystemMessage('Reconnected');
    } else {
      createBtn.disabled = false;
      createBtn.textContent = createBtnLabel;
      joinBtn.disabled = false;
      joinBtn.textContent = joinBtnLabel;
      clearError();
    }
  }

  function handleClose() {
    connected = false;
    if (!roomScreen.hidden) {
      scheduleReconnect();
    } else {
      showError('Lost the connection to the server. Reload the page to try again.');
      createBtn.disabled = true;
      createBtn.textContent = 'Disconnected';
      joinBtn.disabled = true;
    }
  }

  function scheduleReconnect() {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      setConnectionDot('lost', 'Disconnected');
      setConnectionBanner('lost', "Couldn't reconnect. Reload the page to try again.");
      return;
    }
    setConnectionDot('reconnecting', 'Reconnecting\u2026');
    reconnectAttempts++;
    setConnectionBanner('reconnecting', 'Connection lost \u2014 reconnecting\u2026');
    const delay = Math.min(1000 * 2 ** (reconnectAttempts - 1), 10000);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectSocket, delay);
  }

  function handleMessage(event) {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (msg.type === 'ack') {
      const resolve = pending.get(msg.reqId);
      if (resolve) {
        pending.delete(msg.reqId);
        resolve(msg);
      }
      return;
    }

    switch (msg.type) {
      case 'chat-message':
        addTextMessage({ text: msg.text, name: msg.name, mine: false, ts: msg.ts });
        break;
      case 'system':
        addSystemMessage(msg.text);
        updateMembers(msg.members);
        reconcileTypingUsers(msg.members);
        break;
      case 'typing':
        handleTyping(msg.name, msg.isTyping);
        break;
      case 'file-start':
        incoming.set(msg.fileId, {
          chunks: [],
          received: 0,
          total: Math.ceil(msg.size / CHUNK_SIZE) || 1,
          meta: msg,
          wrap: addFileMessage({ name: msg.name, size: msg.size, mine: false, fileId: msg.fileId, from: msg.from }),
        });
        break;
      case 'file-chunk':
        handleIncomingChunk(msg);
        break;
      case 'file-end':
        handleIncomingFileEnd(msg);
        break;
      case 'file-rejected':
        outgoingRejected.add(msg.fileId);
        markFileFailed(messagesEl.querySelector(`[data-file-id="${msg.fileId}"]`), msg.reason);
        break;
      default:
        break;
    }
  }

  // Buttons start disabled (and say so) until the socket is actually open.
  createBtn.disabled = true;
  createBtn.textContent = 'Connecting\u2026';
  joinBtn.disabled = true;
  joinBtn.textContent = 'Connecting\u2026';
  setConnectionDot('reconnecting', 'Connecting\u2026');

  // ---------- Landing actions ----------
  createBtn.addEventListener('click', async () => {
    clearError();
    createBtn.disabled = true;
    const res = await request('create-room', { name: createNameInput.value });
    createBtn.disabled = false;
    if (!res.ok) return showError(res.error || 'Could not create a room.');
    enterRoom(res.code, res.name, res.members);
  });

  joinBtn.addEventListener('click', async () => {
    clearError();
    const code = joinCodeInput.value.trim();
    if (!code) return showError('Enter a room code to join.');
    joinBtn.disabled = true;
    const res = await request('join-room', { code, name: joinNameInput.value });
    joinBtn.disabled = false;
    if (!res.ok) return showError(res.error || 'Could not join that room.');
    enterRoom(res.code, res.name, res.members);
  });

  createNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createBtn.click();
  });
  [joinNameInput, joinCodeInput].forEach((el) => el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinBtn.click();
  }));

  roomCodeBtn.addEventListener('click', () => {
    const original = roomCodeBtn.textContent;
    copyToClipboard(roomCode, () => {
      roomCodeBtn.textContent = 'Copied';
      setTimeout(() => { roomCodeBtn.textContent = original; }, 1000);
    });
  });

  leaveBtn.addEventListener('click', () => window.location.reload());

  // ---------- Chat composer ----------
  // The composer is a textarea (not a single-line input) so that pasted
  // multi-line or indented text keeps its line breaks and spacing —
  // both while being typed and, via addTextMessage's white-space:pre-wrap
  // rendering, exactly as it shows up for everyone else in the room.
  function autoGrowTextarea() {
    textInput.style.height = 'auto';
    textInput.style.height = `${Math.min(textInput.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }

  function sendCurrentMessage() {
    const text = textInput.value;
    if (!text.trim()) return;
    const ts = Date.now();
    send('chat-message', { text });
    addTextMessage({ text, mine: true, ts });
    textInput.value = '';
    autoGrowTextarea();
    send('typing', { isTyping: false });
  }

  composer.addEventListener('submit', (e) => {
    e.preventDefault();
    sendCurrentMessage();
  });

  textInput.addEventListener('keydown', (e) => {
    // Enter sends; Shift+Enter (or an IME composing a character) makes a
    // new line, matching the convention most chat apps use.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendCurrentMessage();
    }
  });

  textInput.addEventListener('input', () => {
    autoGrowTextarea();
    send('typing', { isTyping: true });
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => send('typing', { isTyping: false }), 1200);
  });

  const typingUsers = new Set();

  function refreshTypingIndicator() {
    if (typingUsers.size === 0) {
      typingIndicator.hidden = true;
    } else {
      typingIndicator.hidden = false;
      typingIndicator.textContent = `${Array.from(typingUsers).join(', ')} typing\u2026`;
    }
  }

  function handleTyping(name, isTyping) {
    if (isTyping) typingUsers.add(name); else typingUsers.delete(name);
    refreshTypingIndicator();
  }

  // Someone who disconnects mid-message never gets to send isTyping:false,
  // so drop anyone from the indicator who isn't in the current roster
  // (called whenever the server tells us who's actually still in the room).
  function reconcileTypingUsers(members) {
    if (!members) return;
    let changed = false;
    for (const name of typingUsers) {
      if (!members.includes(name)) {
        typingUsers.delete(name);
        changed = true;
      }
    }
    if (changed) refreshTypingIndicator();
  }

  // ---------- Sending files ----------
  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) trySendFile(fileInput.files[0]);
    fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach((evt) => {
    roomScreen.addEventListener(evt, (e) => {
      e.preventDefault();
      dropOverlay.classList.add('active');
    });
  });
  ['dragleave', 'drop'].forEach((evt) => {
    roomScreen.addEventListener(evt, (e) => {
      e.preventDefault();
      if (evt === 'drop' && e.dataTransfer.files[0]) {
        trySendFile(e.dataTransfer.files[0]);
      }
      dropOverlay.classList.remove('active');
    });
  });

  function trySendFile(file) {
    if (file.size > MAX_FILE_SIZE) {
      addSystemMessage(`"${file.name}" is larger than the ${formatBytes(MAX_FILE_SIZE)} limit and wasn't sent.`);
      return;
    }
    sendFile(file);
  }

  function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  async function sendFile(file) {
    const fileId = makeId();
    send('file-start', { fileId, name: file.name, size: file.size, mime: file.type });
    const wrap = addFileMessage({ name: file.name, size: file.size, mine: true, fileId });

    const totalChunks = Math.ceil(file.size / CHUNK_SIZE) || 1;
    let sentCount = 0;
    for (let i = 0; i < totalChunks; i++) {
      if (outgoingRejected.has(fileId)) {
        outgoingRejected.delete(fileId);
        return; // server already showed the rejection reason on the card
      }
      const slice = file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      const buffer = await slice.arrayBuffer();
      const data = arrayBufferToBase64(buffer);
      send('file-chunk', { fileId, index: i, data });
      sentCount++;
      setFileProgress(wrap, (sentCount / totalChunks) * 100);
      // Yield so the UI (and the socket's outgoing buffer) don't choke on huge files.
      await new Promise((r) => setTimeout(r, 0));
    }
    if (outgoingRejected.has(fileId)) {
      outgoingRejected.delete(fileId);
      return;
    }
    send('file-end', { fileId });
    const url = URL.createObjectURL(file);
    finishFileMessage(wrap, url);
  }

  // ---------- Receiving files ----------
  function handleIncomingChunk({ fileId, index, data }) {
    const entry = incoming.get(fileId);
    if (!entry) return;
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    entry.chunks[index] = bytes;
    entry.received++;
    setFileProgress(entry.wrap, (entry.received / entry.total) * 100);
  }

  function handleIncomingFileEnd({ fileId }) {
    const entry = incoming.get(fileId);
    if (!entry) return;
    const blob = new Blob(entry.chunks, { type: entry.meta.mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    finishFileMessage(entry.wrap, url);
    incoming.delete(fileId);
  }

  connectSocket();
})();
