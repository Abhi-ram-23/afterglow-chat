'use strict';

(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const socket = io({ autoConnect: true, reconnection: true, reconnectionAttempts: 4, timeout: 8000 });

  const landingView = $('#landingView');
  const roomView = $('#roomView');
  const createDialog = $('#createDialog');
  const privacyDialog = $('#privacyDialog');
  const createForm = $('#createForm');
  const joinForm = $('#joinForm');
  const createName = $('#createName');
  const joinName = $('#joinName');
  const joinCode = $('#joinCode');
  const messageInput = $('#messageInput');
  const messageList = $('#messageList');
  const emptyState = $('#emptyState');
  const toastStack = $('#toastStack');
  const imageInput = $('#imageInput');
  const imagePreview = $('#imagePreview');
  const emojiTray = $('#emojiTray');

  let activeRoom = null;
  let memberList = [];
  let messages = [];
  let selectedImage = null;
  let typingTimer = null;
  let typingSent = false;
  let moodIndex = 0;
  const moods = ['', 'mood-mint', 'mood-peach', 'mood-ocean', 'mood-rose', 'mood-amber'];
  const quickReactions = ['💜', '😂', '😭', '🔥', '✨', '👀', '🫶', '💀'];

  function toast(message, type = '') {
    const item = document.createElement('div');
    item.className = `toast ${type}`.trim();
    item.textContent = message;
    toastStack.append(item);
    window.setTimeout(() => {
      item.style.opacity = '0';
      item.style.transform = 'translateY(5px)';
      window.setTimeout(() => item.remove(), 220);
    }, 3300);
  }

  function cleanNickname(value) {
    return String(value || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().replace(/\s+/g, ' ').slice(0, 24);
  }

  function showLanding({ keepQuery = false } = {}) {
    activeRoom = null;
    messages = [];
    memberList = [];
    selectedImage = null;
    if (!keepQuery) {
      const cleanUrl = window.location.pathname;
      window.history.replaceState({}, '', cleanUrl);
    }
    roomView.classList.add('hidden');
    landingView.classList.remove('hidden');
    messageList.querySelectorAll('.message-row, .message-system').forEach((node) => node.remove());
    resetComposer();
    setEmptyState(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function setEmptyState(isEmpty) {
    if (emptyState) emptyState.classList.toggle('hidden', !isEmpty);
  }

  function resetComposer() {
    messageInput.value = '';
    messageInput.style.height = 'auto';
    imageInput.value = '';
    selectedImage = null;
    imagePreview.classList.add('hidden');
    emojiTray.classList.add('hidden');
    $('#typingStatus').textContent = '';
  }

  function enterRoom(response) {
    if (!response || !response.ok || !response.room) return;
    activeRoom = response.room;
    memberList = response.room.members || [];
    messages = Array.isArray(response.messages) ? response.messages.slice() : [];
    $('#roomCodeLabel').textContent = response.room.code;
    $('#roomHeadline').textContent = 'the yap session';
    $('#onlineCount').textContent = `${memberList.length}/6 HERE`;
    landingView.classList.add('hidden');
    roomView.classList.remove('hidden');
    window.history.replaceState({}, '', `${window.location.pathname}#room=${response.room.code}`);
    renderMembers();
    renderHistory();
    messageInput.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function renderMembers() {
    const container = $('#memberList');
    container.replaceChildren();
    memberList.forEach((member, index) => {
      const row = document.createElement('div');
      row.className = 'member-row';
      const avatar = document.createElement('span');
      avatar.className = 'member-avatar';
      avatar.textContent = (member.name || '?').slice(0, 1).toUpperCase();
      const meta = document.createElement('div');
      meta.className = 'member-meta';
      const name = document.createElement('strong');
      name.textContent = member.id === socket.id ? `${member.name} (you)` : member.name;
      const status = document.createElement('span');
      const dot = document.createElement('i');
      dot.className = 'live-dot';
      status.append(dot, document.createTextNode(member.id === socket.id ? 'your side' : 'in the room'));
      meta.append(name, status);
      row.append(avatar, meta);
      container.append(row);
    });
    $('#onlineCount').textContent = `${memberList.length}/6 HERE`;
  }

  function renderHistory() {
    messageList.querySelectorAll('.message-row, .message-system').forEach((node) => node.remove());
    messages.forEach(renderMessage);
    setEmptyState(messages.length === 0);
    scrollToLatest(false);
  }

  function formatTime(timestamp) {
    try { return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
    catch { return ''; }
  }

  function appendSystem(text, timestamp = Date.now()) {
    const node = document.createElement('div');
    node.className = 'message-system';
    node.textContent = `${text} · ${formatTime(timestamp)}`;
    messageList.append(node);
    setEmptyState(messages.length === 0);
    scrollToLatest(true);
  }

  function renderMessage(message) {
    if (!message || !message.id) return;
    if (messageList.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`)) return;
    setEmptyState(false);
    const mine = message.senderId === socket.id;
    const row = document.createElement('article');
    row.className = `message-row${mine ? ' mine' : ''}`;
    row.dataset.messageId = message.id;

    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const sender = document.createElement('strong');
    sender.textContent = mine ? `${message.senderName || 'you'} · you` : (message.senderName || 'friend');
    const time = document.createElement('span');
    time.textContent = formatTime(message.timestamp);
    meta.append(sender, time);
    row.append(meta);

    if (message.type === 'image' && message.dataUrl) {
      const wrap = document.createElement('div');
      wrap.className = 'message-image-wrap';
      const img = document.createElement('img');
      img.className = 'message-image';
      img.src = message.dataUrl;
      img.alt = message.fileName ? `Shared image: ${message.fileName}` : 'Image shared in this room';
      img.loading = 'lazy';
      img.addEventListener('click', () => openImageLightbox(message.dataUrl, message.fileName || 'shared-image'));
      wrap.append(img);
      row.append(wrap);
      if (message.fileName) {
        const fileName = document.createElement('div');
        fileName.className = 'image-file-name';
        fileName.textContent = message.fileName;
        row.append(fileName);
      }
    } else {
      const bubble = document.createElement('div');
      bubble.className = 'message-bubble';
      bubble.textContent = message.text || '';
      row.append(bubble);
    }

    const reactionArea = document.createElement('div');
    reactionArea.className = 'message-reactions';
    paintReactions(reactionArea, message);
    if (reactionArea.childElementCount) row.append(reactionArea);

    const timeLabel = document.createElement('div');
    timeLabel.className = 'message-time';
    timeLabel.textContent = message.type === 'image' ? 'shared a moment' : 'in the moment';
    row.append(timeLabel);

    const reactButton = document.createElement('button');
    reactButton.className = 'react-tool';
    reactButton.type = 'button';
    reactButton.title = 'React to this message';
    reactButton.textContent = '＋';
    reactButton.setAttribute('aria-label', 'React to this message');
    reactButton.addEventListener('click', () => toggleReactionMenu(row, message.id));
    row.append(reactButton);

    messageList.append(row);
    scrollToLatest(true);
  }

  function paintReactions(container, message) {
    container.replaceChildren();
    const reactionMap = message.reactions || {};
    Object.entries(reactionMap).forEach(([emoji, users]) => {
      const ids = Array.isArray(users) ? users : [];
      if (!ids.length) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `reaction-button${ids.includes(socket.id) ? ' reacted' : ''}`;
      button.textContent = `${emoji} ${ids.length}`;
      button.setAttribute('aria-label', `${emoji} reaction, ${ids.length} people`);
      button.addEventListener('click', () => socket.emit('chat:react', { messageId: message.id, emoji }, handleAck));
      container.append(button);
    });
  }

  function toggleReactionMenu(row, messageId) {
    const existing = $('.reaction-menu', row);
    if (existing) { existing.remove(); return; }
    const menu = document.createElement('div');
    menu.className = 'reaction-menu';
    quickReactions.forEach((emoji) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = emoji;
      button.setAttribute('aria-label', `React ${emoji}`);
      button.addEventListener('click', () => {
        socket.emit('chat:react', { messageId, emoji }, handleAck);
        menu.remove();
      });
      menu.append(button);
    });
    row.append(menu);
  }

  function openImageLightbox(dataUrl, fileName) {
    const dialog = document.createElement('dialog');
    dialog.className = 'image-lightbox';
    dialog.style.cssText = 'padding:12px;border:1px solid rgba(226,215,255,.2);border-radius:16px;background:#100d1b;max-width:92vw;max-height:90vh;color:#eee;box-shadow:0 30px 100px #0009;';
    const close = document.createElement('button');
    close.type = 'button'; close.textContent = '×';
    close.setAttribute('aria-label', 'Close image');
    close.style.cssText = 'position:absolute;right:8px;top:8px;width:30px;height:30px;border-radius:8px;border:1px solid #ffffff22;background:#161123;color:#fff;font-size:20px;cursor:pointer;';
    const img = document.createElement('img');
    img.src = dataUrl; img.alt = fileName; img.style.cssText = 'display:block;max-width:86vw;max-height:78vh;object-fit:contain;border-radius:8px;';
    const caption = document.createElement('div');
    caption.textContent = fileName; caption.style.cssText = 'font-size:10px;color:#aaa;padding:9px 2px 2px;';
    dialog.append(close, img, caption);
    document.body.append(dialog);
    close.addEventListener('click', () => { dialog.close(); dialog.remove(); });
    dialog.addEventListener('click', (event) => { if (event.target === dialog) { dialog.close(); dialog.remove(); } });
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    dialog.showModal();
  }

  function scrollToLatest(smooth = true) {
    requestAnimationFrame(() => {
      messageList.scrollTo({ top: messageList.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    });
  }

  function handleAck(response) {
    if (response && response.ok === false) toast(response.error || 'Something went wrong.', 'error');
  }

  function setTyping(isTyping) {
    if (!activeRoom || !socket.connected) return;
    if (typingSent === isTyping) return;
    typingSent = isTyping;
    socket.emit('chat:typing', { typing: isTyping });
  }

  function stopTypingSoon() {
    window.clearTimeout(typingTimer);
    typingTimer = window.setTimeout(() => setTyping(false), 1000);
  }

  function sendText(text) {
    return new Promise((resolve) => {
      if (!activeRoom) return resolve(false);
      const clean = String(text || '').trim();
      if (!clean) return resolve(true);
      socket.emit('chat:send', { type: 'text', text: clean }, (result) => {
        if (!result || !result.ok) {
          toast(result?.error || 'Message did not send. Check your connection.', 'error');
          resolve(false);
        } else resolve(true);
      });
    });
  }

  async function sendCurrentMessage(event) {
    if (event) event.preventDefault();
    if (!activeRoom) return;
    const text = messageInput.value.trim(), image = selectedImage;
    if (!text && !image) return;
    const sendButton = $('.send-button');
    sendButton.disabled = true; sendButton.style.opacity = '.65';
    messageInput.disabled = true;
    setTyping(false);
    try {
      if (image) {
        toast('Sending picture safely…');
        const result = await new Promise((resolve) => {
          const timer = window.setTimeout(() => resolve({ok:false,error:'Image transfer took too long. Try a smaller image or a steadier connection.'}), 65000);
          socket.emit('chat:send', {type:'image',dataUrl:image.dataUrl,fileName:image.fileName}, response => {window.clearTimeout(timer);resolve(response);});
        });
        if (!result || !result.ok) { toast(result?.error || 'Image did not send. Try a smaller one.', 'error'); return; }
        selectedImage = null; imageInput.value = ''; imagePreview.classList.add('hidden');
      }
      if (text) {
        const ok = await sendText(text);
        if (!ok) return;
      }
      messageInput.value = ''; messageInput.style.height = 'auto';
    } catch (error) {
      toast(error?.message || 'Something interrupted the send. Your draft is still here.', 'error');
    } finally {
      sendButton.disabled = false; sendButton.style.opacity = ''; messageInput.disabled = false;
      if (activeRoom) messageInput.focus({preventScroll:true});
    }
  }

  const SAVED_KEY = 'afterglow.savedChats.v1';
  function readSavedChats() { try { return JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'); } catch { return []; } }
  function writeSavedChats(items) { try { localStorage.setItem(SAVED_KEY, JSON.stringify(items)); return true; } catch { toast('Browser storage is full. Save a JSON export instead.', 'error'); return false; } }
  function archiveCurrentChat() {
    if (!activeRoom) return null;
    return { id: activeRoom.code, title: `Chat ${activeRoom.code}`, roomCode: activeRoom.code, savedAt: new Date().toISOString(), messages: messages.map(m => ({id:m.id,type:m.type,text:m.text||'',dataUrl:m.dataUrl||'',fileName:m.fileName||'',senderName:m.senderName||m.sender||'friend',senderId:m.senderId||'saved-user',timestamp:m.timestamp||Date.now(),reactions:m.reactions||{}})) };
  }
  function renderSavedChats() {
    const panel = $('#savedChatsList'); if (!panel) return;
    panel.replaceChildren(); const saved = readSavedChats();
    if (!saved.length) { const empty=document.createElement('div'); empty.className='saved-empty'; empty.textContent='No saved conversations yet. Save one when you leave a room to keep its story.'; panel.append(empty); return; }
    saved.sort((a,b)=>String(b.savedAt).localeCompare(String(a.savedAt))).forEach(chat => {
      const card=document.createElement('article'); card.className='saved-chat-card';
      const title=document.createElement('h3'); title.textContent=chat.title||`Chat ${chat.roomCode}`;
      const meta=document.createElement('p'); meta.textContent=`${(chat.messages||[]).length} messages · saved ${new Date(chat.savedAt).toLocaleString()}`;
      const actions=document.createElement('div'); actions.className='saved-chat-actions';
      const resume=document.createElement('button'); resume.className='button button-primary'; resume.type='button'; resume.textContent='Continue chat ↗';
      resume.addEventListener('click',()=>resumeSavedChat(chat));
      const exportBtn=document.createElement('button'); exportBtn.className='button button-quiet'; exportBtn.type='button'; exportBtn.textContent='Export'; exportBtn.addEventListener('click',()=>downloadSavedChat(chat));
      const del=document.createElement('button'); del.className='button button-quiet'; del.type='button'; del.textContent='Delete'; del.addEventListener('click',()=>{if(confirm('Delete this saved chat from this browser?')){writeSavedChats(readSavedChats().filter(x=>x.id!==chat.id));renderSavedChats();}});
      actions.append(resume,exportBtn,del); card.append(title,meta,actions); panel.append(card);
    });
  }
  function downloadSavedChat(chat) {
    const blob=new Blob([JSON.stringify(chat,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=url;a.download=`afterglow-saved-${chat.roomCode||'chat'}.json`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function resumeSavedChat(chat) {
    const name=cleanNickname(prompt('Choose your nickname to continue this saved conversation:')||'');
    if(!name)return;
    if(!socket.connected){toast('Connecting… try again in a moment.','error');return;}
    socket.emit('room:create',{name,seedMessages:(chat.messages||[]).slice(-100)},response=>{
      if(!response||!response.ok){toast(response?.error||'Could not reopen this chat.','error');return;}
      enterRoom(response);toast('A fresh room is open with your saved history. Share the new invite link so friends can rejoin.','success');
    });
  }
  function leaveWithChoice() {
    if (!activeRoom) { showLanding(); return; }
    const shouldSave = confirm('Before you leave: press OK to save this chat on this browser, or Cancel to leave without saving.');
    if (shouldSave) {
      const archive=archiveCurrentChat(); if(archive){const saved=readSavedChats().filter(x=>x.id!==archive.id);saved.push(archive);writeSavedChats(saved);renderSavedChats();toast('Saved on this browser. Open Saved Chats to continue later.','success');}
    }
    const roomCode=activeRoom.code;
    socket.emit('room:leave',()=>{}); showLanding();
    toast(shouldSave ? `Saved and left ${roomCode}.` : `Left ${roomCode} without saving.`, shouldSave?'success':'');
  }

  function exportChat() {
    if (!activeRoom) return;
    const exportData = {
      app: 'afterglow',
      exportType: 'user-requested-local-copy',
      roomCode: activeRoom.code,
      exportedAt: new Date().toISOString(),
      note: 'This file was deliberately saved to your device. Shared images are embedded as data URLs. Protect or delete this file when you no longer need it.',
      messages: messages.map((message) => ({
        type: message.type,
        sender: message.senderName,
        sentAt: new Date(message.timestamp).toISOString(),
        ...(message.type === 'image' ? { fileName: message.fileName || 'image', imageDataUrl: message.dataUrl } : { text: message.text }),
        reactions: Object.fromEntries(Object.entries(message.reactions || {}).map(([emoji, ids]) => [emoji, Array.isArray(ids) ? ids.length : 0]).filter(([, count]) => count > 0)),
      })),
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `afterglow-${activeRoom.code}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Saved to your device. This copy can outlive the room.', 'success');
  }

  async function optimizeImage(file) {
    const MAX_BYTES = 1.8 * 1024 * 1024;
    if (!file || !/^image\/(png|jpeg|webp|gif)$/i.test(file.type)) throw new Error('Choose a PNG, JPG, WEBP or GIF image.');
    if (file.type === 'image/gif') {
      if (file.size > MAX_BYTES) throw new Error('Animated GIFs must be under 1.8 MB to keep the chat stable.');
      return { dataUrl: await fileToDataUrl(file), fileName: file.name || 'shared.gif' };
    }
    let bitmap;
    try { bitmap = await createImageBitmap(file); } catch { throw new Error('This image could not be opened. Try saving it as JPG or PNG.'); }
    try {
      const maxSide = 1280;
      const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('This browser could not process the image.');
      context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      let dataUrl = canvas.toDataURL('image/jpeg', 0.78);
      for (const quality of [0.65, 0.52, 0.4]) {
        if (Math.floor((dataUrl.split(',')[1] || '').length * 3 / 4) <= MAX_BYTES) break;
        dataUrl = canvas.toDataURL('image/jpeg', quality);
      }
      if (Math.floor((dataUrl.split(',')[1] || '').length * 3 / 4) > MAX_BYTES) throw new Error('That picture is too detailed to send. Try a smaller image.');
      const safeName = (file.name ? file.name.replace(/\.[^.]+$/, '') : 'shared-image') + '.jpg';
      return { dataUrl, fileName: safeName.slice(0, 100) };
    } finally { bitmap.close?.(); }
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('Could not read that image.'));
      reader.readAsDataURL(file);
    });
  }

  $('#openCreate').addEventListener('click', () => {
    createName.value = '';
    if (!createDialog.open) createDialog.showModal();
    window.setTimeout(() => createName.focus(), 50);
  });
  $('#closeCreate').addEventListener('click', () => createDialog.close());
  createDialog.addEventListener('click', (event) => { if (event.target === createDialog) createDialog.close(); });

  createForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = cleanNickname(createName.value);
    if (!name) { toast('Choose a nickname first.', 'error'); createName.focus(); return; }
    if (!socket.connected) { toast('Connecting to Afterglow… try again in a moment.', 'error'); return; }
    const button = $('.modal-submit', createForm);
    button.disabled = true;
    button.style.opacity = '.7';
    socket.emit('room:create', { name }, (response) => {
      button.disabled = false; button.style.opacity = '';
      if (!response || !response.ok) { toast(response?.error || 'Could not create a room.', 'error'); return; }
      createDialog.close();
      enterRoom(response);
      toast('Your room is live. Send your person the invite.', 'success');
    });
  });

  joinForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = cleanNickname(joinName.value);
    const code = joinCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
    if (!name) { toast('Add a nickname before joining.', 'error'); joinName.focus(); return; }
    if (code.length !== 10) { toast('Room codes are ten characters long.', 'error'); joinCode.focus(); return; }
    if (!socket.connected) { toast('Connecting to Afterglow… try again in a moment.', 'error'); return; }
    const button = $('.join-submit', joinForm);
    button.disabled = true; button.style.opacity = '.7';
    socket.emit('room:join', { name, code }, (response) => {
      button.disabled = false; button.style.opacity = '';
      if (!response || !response.ok) { toast(response?.error || 'Could not join that room.', 'error'); return; }
      enterRoom(response);
      toast('You made it. The room is yours.', 'success');
    });
  });
  joinCode.addEventListener('input', () => { joinCode.value = joinCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10); });

  $('#copyInvite').addEventListener('click', async () => {
    if (!activeRoom) return;
    const link = `${window.location.origin}${window.location.pathname}#room=${activeRoom.code}`;
    try {
      await navigator.clipboard.writeText(link);
      toast('Invite link copied. Send it to your person.', 'success');
    } catch {
      window.prompt('Copy this invite link:', link);
    }
  });

  $('#saveChat').addEventListener('click', exportChat);
  $('#leaveRoom').addEventListener('click', leaveCurrentRoom);
  $('#roomBrandHome').addEventListener('click', (event) => { event.preventDefault(); leaveCurrentRoom(); });
  $('#brandHome').addEventListener('click', (event) => { if (activeRoom) { event.preventDefault(); leaveCurrentRoom(); } });
  $('#footerHome').addEventListener('click', (event) => { if (activeRoom) { event.preventDefault(); leaveCurrentRoom(); } });

  function leaveCurrentRoom() { leaveWithChoice(); }

  $('#wipeRoom').addEventListener('click', () => {
    if (!activeRoom) return;
    const confirmed = window.confirm('Wipe every message and image in this room for both people? This cannot be undone.');
    if (!confirmed) return;
    socket.emit('room:wipe', (response) => {
      if (response && response.ok) toast('Room wiped clean. A fresh page.', 'success');
      else handleAck(response);
    });
  });

  const themeNames = ['lilac','mint','peach','ocean','rose','amber'];
  $('#vibeButton').addEventListener('click', () => {
    moodIndex = (moodIndex + 1) % moods.length;
    document.body.classList.remove(...moods.filter(Boolean));
    if (moods[moodIndex]) document.body.classList.add(moods[moodIndex]);
    try { localStorage.setItem('afterglow.theme', themeNames[moodIndex]); } catch {}
    toast(`Room theme: ${themeNames[moodIndex]}. Only your screen changes.`);
  });
  try { const savedTheme=localStorage.getItem('afterglow.theme'); const idx=themeNames.indexOf(savedTheme); if(idx>0){moodIndex=idx;document.body.classList.add(moods[idx]);} } catch {}

  $('#attachImage').addEventListener('click', () => imageInput.click());
  imageInput.addEventListener('change', async () => {
    const file = imageInput.files && imageInput.files[0];
    if (!file) return;
    try {
      toast('Prepping that pic…');
      const optimized = await optimizeImage(file);
      selectedImage = optimized;
      $('#imagePreviewName').textContent = `${optimized.fileName} · ready to send`;
      imagePreview.classList.remove('hidden');
      toast('Picture ready. It sends only when you hit send.', 'success');
    } catch (error) {
      selectedImage = null;
      imageInput.value = '';
      imagePreview.classList.add('hidden');
      toast(error.message || 'Could not prepare that image.', 'error');
    }
  });
  $('#cancelImage').addEventListener('click', () => {
    selectedImage = null;
    imageInput.value = '';
    imagePreview.classList.add('hidden');
  });

  const emojiCollection = '😀 😃 😄 😁 😆 😅 😂 🙂 🙃 😉 😊 😍 🥰 😘 😗 😙 😚 😋 😛 😜 🤪 🤨 🧐 🤓 😎 🥸 🤩 🥳 😏 😒 😞 😔 😟 😕 🙁 ☹️ 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🫣 🤭 🫢 🫡 🤫 🫠 🤥 😶 😶‍🌫️ 😐 😑 😬 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 😵‍💫 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕 🤑 🤠 😈 👿 👹 👺 🤡 💩 👻 💀 ☠️ 👽 👾 🤖 🎃 😺 😸 😹 😻 😼 😽 🙀 😿 😾 🙈 🙉 🙊 💋 💌 💘 💝 💖 💗 💓 💞 💕 💟 ❣️ 💔 ❤️ 🩷 🧡 💛 💚 💙 🩵 💜 🤎 🖤 🩶 🤍 💯 💢 💥 💫 💦 💨 🕳️ 💬 👁️‍🗨️ 🗨️ 🗯️ 💭 💤 👋 🤚 🖐️ ✋ 🖖 🫱 🫲 🫳 🫴 👌 🤌 🤏 ✌️ 🤞 🫰 🤟 🤘 🤙 👈 👉 👆 🖕 👇 ☝️ 🫵 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 🫶 👐 🤲 🤝 🙏 ✍️ 💅 🤳 💪 🦾 🦿 🦵 🦶 👂 🦻 👃 🧠 🫀 🫁 🦷 🦴 👀 👁️ 👅 👄 🫦 🌈 ☀️ 🌤️ ⛅ 🌥️ 🌦️ 🌧️ ⛈️ 🌩️ 🌨️ ❄️ ☃️ ⛄ 🌬️ 💨 🌪️ 🌫️ 🌊 💧 💦 ☔ ☂️ 🌍 🌎 🌏 🌕 🌖 🌗 🌘 🌑 🌒 🌓 🌔 ⭐ 🌟 ✨ ⚡ 🔥 ☄️ 💥 🎉 🎊 🎈 🎀 🎁 🪄 🪩 🎵 🎶 💃 🕺 🧸 🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐻‍❄️ 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🪱 🦋 🐌 🐞 🐜 🪰 🪲 🦟 🦗 🕷️ 🦂 🐢 🐍 🦎 🦖 🦕 🐙 🦑 🦐 🦞 🦀 🐡 🐠 🐟 🐬 🐳 🦈 🐊 🐅 🐆 🦓 🦍 🦧 🐘 🦛 🦏 🐪 🐫 🦒 🦘 🦬 🐃 🐂 🐄 🐎 🐖 🐏 🐑 🦙 🐐 🦌 🐕 🐩 🦮 🐈 🐈‍⬛ 🐓 🦃 🦚 🦜 🦢 🦩 🕊️ 🐇 🦝 🦨 🦡 🦫 🦦 🦥 🐁 🐀 🐿️ 🦔 🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🍆 🥑 🥦 🥬 🥒 🌶️ 🫑 🌽 🥕 🫒 🧄 🧅 🥔 🍠 🥐 🥯 🍞 🥖 🥨 🧀 🥚 🍳 🧈 🥞 🧇 🥓 🥩 🍗 🍖 🌭 🍔 🍟 🍕 🫓 🥪 🥙 🧆 🌮 🌯 🫔 🥗 🥘 🫕 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🦪 🍤 🍙 🍚 🍘 🍥 🥠 🥮 🍢 🍡 🍧 🍨 🍦 🥧 🧁 🍰 🎂 🍮 🍭 🍬 🍫 🍿 🍩 🍪 🌰 🥜 🍯 🥛 🍼 ☕ 🫖 🍵 🧃 🥤 🧋 🍶 🍺 🍻 🥂 🍷 🥃 🍸 🍹 🧉 🧊 🥄 🍴 🍽️ 🥣 🥡 🥢 🧂 🏳️‍🌈 🏳️‍⚧️'.split(' ');
  function insertEmoji(emoji) { const start=messageInput.selectionStart,end=messageInput.selectionEnd;messageInput.setRangeText(emoji,start,end,'end');messageInput.focus();messageInput.dispatchEvent(new Event('input',{bubbles:true})); }
  $('#emojiToggle').addEventListener('click', () => {
    if (emojiTray.childElementCount < 20) { emojiTray.replaceChildren(); const search=document.createElement('input');search.type='search';search.placeholder='Search emojis…';search.className='emoji-search';search.setAttribute('aria-label','Search emojis');const grid=document.createElement('div');grid.className='emoji-grid';emojiTray.append(search,grid);
      const paint=(term='')=>{grid.replaceChildren();emojiCollection.filter(e=>!term||e.includes(term)).slice(0,420).forEach(emoji=>{const b=document.createElement('button');b.type='button';b.textContent=emoji;b.title=emoji;b.addEventListener('click',()=>insertEmoji(emoji));grid.append(b);});};paint();search.addEventListener('input',()=>paint(search.value.trim())); }
    emojiTray.classList.toggle('hidden');
  });

  $('#composerForm').addEventListener('submit', sendCurrentMessage);
  messageInput.addEventListener('input', () => {
    messageInput.style.height = 'auto';
    messageInput.style.height = `${Math.min(messageInput.scrollHeight, 140)}px`;
    if (messageInput.value.trim()) { setTyping(true); stopTypingSoon(); }
    else { window.clearTimeout(typingTimer); setTyping(false); }
  });
  messageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendCurrentMessage(event);
    }
  });

  $('#privacyDetails').addEventListener('click', () => privacyDialog.showModal());
  $('#chatPrivacyLink').addEventListener('click', () => privacyDialog.showModal());
  $('#closePrivacy').addEventListener('click', () => privacyDialog.close());
  $('#privacyGotIt').addEventListener('click', () => privacyDialog.close());
  privacyDialog.addEventListener('click', (event) => { if (event.target === privacyDialog) privacyDialog.close(); });

  // Incoming realtime events.
  socket.on('room:members', (members) => {
    if (!activeRoom || !Array.isArray(members)) return;
    memberList = members;
    renderMembers();
  });
  socket.on('room:sync', (snapshot) => {
    if (!activeRoom || !snapshot || !snapshot.room || snapshot.room.code !== activeRoom.code) return;
    activeRoom = snapshot.room;
    memberList = snapshot.room.members || [];
    messages = Array.isArray(snapshot.messages) ? snapshot.messages.slice() : [];
    renderMembers();
    renderHistory();
    if (snapshot.reason === 'history-limit') toast('Older messages left active memory; Save chat keeps a local copy.', 'success');
    else toast('Back in sync. The active room is up to date.', 'success');
  });
  socket.on('chat:message', (message) => {
    if (!activeRoom || !message || message.roomCode && message.roomCode !== activeRoom.code) return;
    if (!messages.some((item) => item.id === message.id)) messages.push(message);
    renderMessage(message);
  });
  socket.on('chat:system', (event) => {
    if (!activeRoom || !event) return;
    appendSystem(event.text || 'Someone moved through the room', event.timestamp);
  });
  socket.on('chat:typing', (event) => {
    if (!activeRoom || !event || event.id === socket.id) return;
    $('#typingStatus').textContent = event.typing ? `${event.name || 'Your person'} is typing…` : '';
  });
  socket.on('chat:reaction', (event) => {
    if (!activeRoom || !event || !event.messageId) return;
    const message = messages.find((item) => item.id === event.messageId);
    if (!message) return;
    message.reactions = event.reactions || {};
    const row = messageList.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`);
    if (!row) return;
    const oldArea = $('.message-reactions', row);
    const area = oldArea || document.createElement('div');
    area.className = 'message-reactions';
    paintReactions(area, message);
    if (area.childElementCount && !oldArea) row.insertBefore(area, $('.message-time', row));
    if (!area.childElementCount && oldArea) oldArea.remove();
  });
  socket.on('room:wiped', (event) => {
    if (!activeRoom) return;
    messages = [];
    messageList.querySelectorAll('.message-row, .message-system').forEach((node) => node.remove());
    setEmptyState(true);
    appendSystem(`Room wiped by ${event?.by || 'someone'}`, event?.timestamp || Date.now());
  });
  socket.on('room:ended', (event) => {
    if (!activeRoom) return;
    const reason = event?.reason || 'This room ended. Its temporary chat has been cleared.';
    showLanding();
    toast(reason, 'success');
  });
  socket.on('connect_error', () => toast('Could not establish a direct connection. Check your network and try again.', 'error'));
  socket.on('disconnect', (reason) => {
    if (activeRoom) {
      showLanding();
      toast('Connection lost. This room session ended on your side; rejoin only if the invite still works.', 'error');
    }
    if (reason === 'io server disconnect') socket.connect();
  });

  $('#savedChatsButton')?.addEventListener('click', () => { landingView.classList.add('hidden'); $('#savedChatsView').classList.remove('hidden'); renderSavedChats(); window.scrollTo({top:0,behavior:'smooth'}); });
  $('#savedChatsBack')?.addEventListener('click', () => { $('#savedChatsView').classList.add('hidden'); landingView.classList.remove('hidden'); });
  // The query string is an invite, not an automatic join: nickname is still required.
  const queryParams = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  // Prefer a URL fragment: browsers do not send fragments to the server in HTTP requests.
  const invitedCode = (hashParams.get('room') || queryParams.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
  if (invitedCode.length === 10) {
    joinCode.value = invitedCode;
    $('#join-section').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // Small cursor light on pointer devices, with no polling/timers.
  const glow = $('#cursorGlow');
  window.addEventListener('pointermove', (event) => {
    if (event.pointerType !== 'touch') {
      glow.style.left = `${event.clientX - 170}px`;
      glow.style.top = `${event.clientY - 170}px`;
    }
  }, { passive: true });

  // Reveal fallback if the browser disables CSS animation for accessibility.
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    $$('.reveal').forEach((element) => { element.style.opacity = '1'; element.style.transform = 'none'; });
  }
})();
