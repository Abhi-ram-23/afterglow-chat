/*
 * Afterglow static/P2P transport.
 * Uses PeerJS only as a signaling broker; chat payloads travel browser-to-browser
 * over WebRTC data channels. No chat backend or database is required.
 */
(() => {
  'use strict';

  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const MAX_PARTICIPANTS = 2;
  const MAX_MESSAGES_PER_ROOM = 300;
  const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
  const MAX_ROOM_CONTENT_BYTES = 20 * 1024 * 1024;
  const MAX_TEXT_LENGTH = 4000;
  const ALLOWED_REACTIONS = new Set(['💜', '😂', '😭', '🔥', '✨', '👀', '🫶', '💀']);
  const CHUNK_SIZE = 40_000;
  const PEER_OPTIONS = {
    debug: 1,
    config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] },
  };

  function cleanName(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().replace(/\s+/g, ' ').slice(0, 24);
  }
  function fail(error) { return { ok: false, error }; }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function randomCode() {
    const bytes = new Uint8Array(10);
    if (globalThis.crypto?.getRandomValues) crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    return Array.from(bytes, (byte) => CODE_CHARS[byte % CODE_CHARS.length]).join('');
  }
  function approxDataBytes(dataUrl) {
    const part = String(dataUrl).split(',')[1] || '';
    return Math.floor(part.length * 3 / 4);
  }

  class AfterglowSocket {
    constructor() {
      this.id = null;
      this.connected = false;
      this.listeners = new Map();
      this.peer = null;
      this.conn = null;
      this.hostRoom = null;
      this.guestRoom = null;
      this.currentRoom = null;
      this.username = null;
      this.requestCounter = 0;
      this.pendingAcks = new Map();
      this.chunkBuffers = new WeakMap();
      this.manualClose = false;
      this._openMainPeer();
      window.addEventListener('beforeunload', () => this._dispose(), { once: true });
    }

    on(event, callback) {
      if (!this.listeners.has(event)) this.listeners.set(event, new Set());
      this.listeners.get(event).add(callback);
      return this;
    }
    once(event, callback) {
      const wrapped = (...args) => { this.off(event, wrapped); callback(args[0]); };
      return this.on(event, wrapped);
    }
    off(event, callback) { this.listeners.get(event)?.delete(callback); return this; }
    dispatch(event, payload) {
      for (const callback of this.listeners.get(event) || []) {
        try { callback(payload); } catch (error) { console.error('Afterglow event listener failed:', error); }
      }
    }
    timeout(_milliseconds) { return this; }
    connect() { if (!this.connected) this._openMainPeer(); return this; }

    _openMainPeer() {
      if (this.peer || this.manualClose) return;
      if (typeof window.Peer !== 'function') {
        this.dispatch('connect_error', new Error('The peer connection library did not load. Refresh the page or check your network.'));
        window.setTimeout(() => this._openMainPeer(), 2500);
        return;
      }
      let peer;
      try { peer = new window.Peer(undefined, PEER_OPTIONS); }
      catch (error) { this.dispatch('connect_error', error); return; }
      this.peer = peer;
      peer.on('open', (id) => {
        this.id = id;
        this.connected = true;
        this.dispatch('connect');
      });
      peer.on('error', (error) => {
        if (this.peer === peer && !this.connected) this.dispatch('connect_error', error);
      });
      peer.on('disconnected', () => {
        // Once a WebRTC data channel is established, it can outlive the signaling socket.
        if (!this.currentRoom) {
          this.connected = false;
          this.dispatch('disconnect', 'signaling disconnected');
          try { peer.reconnect(); } catch { /* A refresh can establish a fresh peer. */ }
        }
      });
    }

    emit(event, payload, callback) {
      if (typeof payload === 'function') { callback = payload; payload = {}; }
      payload = payload && typeof payload === 'object' ? payload : {};
      if (event === 'room:create') { this._createRoom(payload.name, callback); return this; }
      if (event === 'room:join') { this._joinRoom(payload.name, payload.code, callback); return this; }
      if (event === 'room:leave') { this._leaveRoom(callback); return this; }

      if (this.hostRoom && this.currentRoom?.role === 'host') {
        const result = this._processHostEvent(this.id, this.username, event, payload);
        if (callback) callback(result);
        return this;
      }
      if (this.guestRoom && this.conn?.open) {
        this._sendRequest(this.conn, event, payload, callback);
        return this;
      }
      if (callback) callback(fail('You are not in an active room.'));
      return this;
    }

    async _createRoom(nameValue, callback) {
      if (!this.connected || !this.id) return callback?.(fail('Still connecting. Try again in a moment.'));
      if (this.currentRoom) return callback?.(fail('Leave your current room first.'));
      const name = cleanName(nameValue);
      if (!name) return callback?.(fail('Add a nickname first.'));

      for (let attempt = 0; attempt < 10; attempt += 1) {
        const code = randomCode();
        let roomPeer;
        try { roomPeer = new window.Peer(code, PEER_OPTIONS); }
        catch (error) { return callback?.(fail(error.message || 'Could not start the room.')); }
        const result = await new Promise((resolve) => {
          let done = false;
          const finish = (value) => {
            if (done) return;
            done = true;
            window.clearTimeout(timer);
            resolve(value);
          };
          const timer = window.setTimeout(() => finish({ ok: false, error: { type: 'timeout', message: 'Room setup timed out.' } }), 9000);
          roomPeer.on('open', (id) => finish({ ok: true, id }));
          roomPeer.on('error', (error) => finish({ ok: false, error }));
        });
        if (result.ok) {
          const room = {
            code, createdAt: Date.now(), hostPeer: roomPeer,
            users: new Map([[this.id, { name, color: '#b6a0ff' }]]),
            connection: null, messages: [], totalBytes: 0, rateLimits: new Map(), ending: false,
          };
          this.hostRoom = room;
          this.currentRoom = { code, role: 'host' };
          this.username = name;
          roomPeer.on('connection', (conn) => this._acceptGuest(room, conn));
          roomPeer.on('error', (error) => {
            if (this.hostRoom === room) this.dispatch('connect_error', error);
          });
          callback?.({ ok: true, room: this._publicRoom(room), messages: [] });
          return;
        }
        try { roomPeer.destroy(); } catch { /* Discard a failed room ID. */ }
        if (result.error?.type !== 'unavailable-id') {
          callback?.(fail(result.error?.message || 'Could not start a room. Please try again.'));
          return;
        }
      }
      callback?.(fail('Could not find a free room code. Please try again.'));
    }

    _joinRoom(nameValue, codeValue, callback) {
      if (!this.connected || !this.peer) return callback?.(fail('Still connecting. Try again in a moment.'));
      if (this.currentRoom || this.conn) return callback?.(fail('Leave your current room first.'));
      const name = cleanName(nameValue);
      const code = String(codeValue || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
      if (!name) return callback?.(fail('Add a nickname first.'));
      if (code.length !== 10) return callback?.(fail('Enter the 10-character room code.'));

      let conn;
      try {
        conn = this.peer.connect(code, { reliable: true, serialization: 'json', metadata: { app: 'afterglow', role: 'guest' } });
      } catch (error) { return callback?.(fail(error.message || 'Could not connect to that room.')); }
      this.conn = conn;
      const timer = window.setTimeout(() => {
        if (this.conn === conn && !this.currentRoom) {
          try { conn.close(); } catch { /* noop */ }
          this.conn = null;
          callback?.(fail('Could not reach that room. Check the code and try again.'));
        }
      }, 15_000);
      let finished = false;
      const finish = (response) => {
        if (finished) return;
        finished = true;
        window.clearTimeout(timer);
        callback?.(response);
      };
      conn.on('open', () => {
        this.guestRoom = { code, name, connection: conn, joining: true };
        this.currentRoom = { code, role: 'guest' };
        this.username = name;
        this._sendRequest(conn, 'room:join', { name, code }, (response) => {
          if (response?.ok) {
            if (this.guestRoom) { this.guestRoom.joining = false; this.guestRoom.room = response.room; }
            finish(response);
          } else {
            this._clearGuest(false);
            finish(response || fail('That room is no longer available.'));
          }
        });
      });
      this._bindConnection(conn, (packet) => this._handleGuestPacket(conn, packet));
      conn.on('close', () => {
        if (this.conn !== conn) return;
        const wasActive = Boolean(this.guestRoom && !this.guestRoom.joining);
        this._clearGuest(false);
        if (wasActive) this.dispatch('room:ended', { reason: 'The direct connection closed. This room has ended.' });
        if (!finished) finish(fail('That room is gone, full, or unreachable. Ask for a fresh invite.'));
      });
      conn.on('error', (error) => {
        if (this.conn === conn && !this.currentRoom) finish(fail(error?.message || 'Could not connect to that room.'));
      });
      return this;
    }

    _acceptGuest(room, conn) {
      this._bindConnection(conn, (packet) => this._handleHostPacket(room, conn, packet));
      conn.on('close', () => {
        if (this.hostRoom === room && room.connection === conn && !room.ending) {
          this._endRoom('Your person left. The room and its messages were cleared.', { dispatchLocal: true, notifyGuest: false });
        }
      });
      conn.on('error', () => {
        if (this.hostRoom === room && room.connection === conn && !room.ending) {
          this._endRoom('The direct connection ended. The room was cleared.', { dispatchLocal: true, notifyGuest: false });
        }
      });
    }

    _bindConnection(conn, handler) {
      conn.on('data', (packet) => {
        if (packet && packet.__afterglowChunk === true) {
          const buffers = this._getChunkBuffer(conn);
          if (!Number.isInteger(packet.total) || packet.total < 1 || packet.total > 400 ||
              !Number.isInteger(packet.index) || packet.index < 0 || packet.index >= packet.total ||
              typeof packet.id !== 'string' || typeof packet.data !== 'string') return;
          let entry = buffers.get(packet.id);
          if (!entry) { entry = { total: packet.total, pieces: new Array(packet.total), received: 0, length: 0 }; buffers.set(packet.id, entry); }
          if (entry.total !== packet.total || entry.pieces[packet.index] !== undefined) return;
          entry.pieces[packet.index] = packet.data;
          entry.received += 1;
          entry.length += packet.data.length;
          if (entry.length > MAX_ROOM_CONTENT_BYTES + 2_000_000) { buffers.delete(packet.id); return; }
          if (entry.received === entry.total) {
            buffers.delete(packet.id);
            try { handler(JSON.parse(entry.pieces.join(''))); } catch { /* Ignore malformed packet. */ }
          }
          return;
        }
        handler(packet);
      });
    }

    _getChunkBuffer(conn) {
      if (!this.chunkBuffers.has(conn)) this.chunkBuffers.set(conn, new Map());
      return this.chunkBuffers.get(conn);
    }

    _sendPacket(conn, packet) {
      if (!conn || conn.open !== true) return false;
      try {
        const encoded = JSON.stringify(packet);
        if (encoded.length <= CHUNK_SIZE) { conn.send(packet); return true; }
        const chars = Array.from(encoded); // Keep Unicode code points intact while chunking.
        const total = Math.ceil(chars.length / CHUNK_SIZE);
        if (total > 400) return false;
        const id = (globalThis.crypto?.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        for (let index = 0; index < total; index += 1) {
          conn.send({ __afterglowChunk: true, id, index, total, data: chars.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE).join('') });
        }
        return true;
      } catch (error) {
        console.warn('Afterglow could not send a packet.', error);
        return false;
      }
    }

    _sendRequest(conn, event, payload, callback) {
      const requestId = `${++this.requestCounter}-${Date.now()}`;
      if (typeof callback === 'function') this.pendingAcks.set(requestId, { callback, event });
      const sent = this._sendPacket(conn, { kind: 'request', requestId, event, payload });
      if (!sent) {
        this.pendingAcks.delete(requestId);
        if (callback) callback(fail('The direct connection is not ready. Try again.'));
      }
    }

    _sendAck(conn, requestId, result) {
      if (!requestId) return;
      this._sendPacket(conn, { kind: 'ack', requestId, result });
    }

    _handleHostPacket(room, conn, packet) {
      if (this.hostRoom !== room || !packet || packet.kind !== 'request' || typeof packet.event !== 'string') return;
      if (packet.event === 'room:join') {
        const name = cleanName(packet.payload?.name);
        const code = String(packet.payload?.code || '').toUpperCase();
        if (code !== room.code) { this._refuseJoin(conn, packet.requestId, 'The invite code does not match.'); return; }
        if (!name) { this._refuseJoin(conn, packet.requestId, 'Add a nickname first.'); return; }
        if (room.connection && room.connection !== conn) { this._refuseJoin(conn, packet.requestId, 'This room already has two people.'); return; }
        if (room.users.size >= MAX_PARTICIPANTS && !room.users.has(conn.peer)) { this._refuseJoin(conn, packet.requestId, 'This room already has two people.'); return; }
        if (!room.users.has(conn.peer)) {
          room.connection = conn;
          room.users.set(conn.peer, { name, color: '#77e6ce' });
        }
        this._sendAck(conn, packet.requestId, { ok: true, room: this._publicRoom(room), messages: clone(room.messages) });
        this._system(room, `${name} slid into the room`);
        this._broadcastMembers(room);
        return;
      }
      const user = room.users.get(conn.peer);
      if (room.connection !== conn || !user) { this._sendAck(conn, packet.requestId, fail('You are not in this room.')); return; }
      if (packet.event === 'room:leave') {
        this._sendAck(conn, packet.requestId, { ok: true });
        this._endRoom(`${user.name} left. The room and its messages were cleared.`, { dispatchLocal: true, notifyGuest: true });
        return;
      }
      const result = this._processHostEvent(conn.peer, user.name, packet.event, packet.payload || {});
      this._sendAck(conn, packet.requestId, result);
    }

    _refuseJoin(conn, requestId, message) {
      this._sendAck(conn, requestId, fail(message));
      // Let the rejection acknowledgement drain before closing the data channel.
      window.setTimeout(() => { try { conn.close(); } catch { /* noop */ } }, 180);
    }

    _handleGuestPacket(conn, packet) {
      if (!packet || typeof packet !== 'object') return;
      if (packet.kind === 'ack' && typeof packet.requestId === 'string') {
        const pending = this.pendingAcks.get(packet.requestId);
        if (!pending) return;
        this.pendingAcks.delete(packet.requestId);
        if (pending.event === 'room:leave') this._clearGuest(false);
        pending.callback(packet.result);
        return;
      }
      if (packet.kind === 'event' && typeof packet.event === 'string') {
        if (packet.event === 'room:ended') {
          const wasActive = Boolean(this.guestRoom);
          this._clearGuest(false);
          if (wasActive) this.dispatch('room:ended', packet.payload || {});
          return;
        }
        this.dispatch(packet.event, packet.payload);
      }
    }

    _publicRoom(room) {
      return {
        code: room.code, createdAt: room.createdAt, participantLimit: MAX_PARTICIPANTS,
        members: [...room.users.entries()].map(([id, user]) => ({ id, name: user.name, color: user.color })),
      };
    }

    _broadcastMembers(room) {
      const members = this._publicRoom(room).members;
      this.dispatch('room:members', clone(members));
      if (room.connection?.open) this._sendPacket(room.connection, { kind: 'event', event: 'room:members', payload: members });
    }

    _system(room, text) {
      const message = { id: `system-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text, timestamp: Date.now() };
      this.dispatch('chat:system', clone(message));
      if (room.connection?.open) this._sendPacket(room.connection, { kind: 'event', event: 'chat:system', payload: message });
    }

    _broadcastRoom(room, event, payload) {
      this.dispatch(event, clone(payload));
      if (room.connection?.open) this._sendPacket(room.connection, { kind: 'event', event, payload });
    }

    _allowBurst(room, senderId, key, limit, windowMs) {
      const now = Date.now();
      const id = `${senderId}:${key}`;
      const bucket = room.rateLimits.get(id) || { start: now, count: 0 };
      if (now - bucket.start >= windowMs) { bucket.start = now; bucket.count = 0; }
      bucket.count += 1;
      room.rateLimits.set(id, bucket);
      return bucket.count <= limit;
    }

    _processHostEvent(senderId, senderName, event, payload) {
      const room = this.hostRoom;
      if (!room || room.ending || !room.users.has(senderId)) return fail('This room is no longer active.');
      if (event === 'chat:send') {
        if (!this._allowBurst(room, senderId, 'send', 30, 5000)) return fail('A little too fast — pause for a second.');
        const type = payload.type === 'image' ? 'image' : 'text';
        let message;
        if (type === 'text') {
          const text = typeof payload.text === 'string' ? payload.text.trim().slice(0, MAX_TEXT_LENGTH) : '';
          if (!text) return fail('Write a message first.');
          message = { id: (globalThis.crypto?.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random()}`, type, text, senderId, senderName, timestamp: Date.now(), reactions: {} };
        } else {
          const dataUrl = typeof payload.dataUrl === 'string' ? payload.dataUrl : '';
          if (!/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) return fail('That image format is not supported. Try PNG, JPG, WEBP, or GIF.');
          const bytes = approxDataBytes(dataUrl);
          if (bytes < 1 || bytes > MAX_IMAGE_BYTES) return fail('Images must be 4 MB or smaller.');
          message = {
            id: (globalThis.crypto?.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random()}`, type, dataUrl,
            fileName: typeof payload.fileName === 'string' ? payload.fileName.replace(/[\u0000-\u001f]/g, '').slice(0, 100) : 'image',
            senderId, senderName, timestamp: Date.now(), reactions: {},
          };
        }
        const bytes = new TextEncoder().encode(JSON.stringify(message)).length;
        if (room.totalBytes + bytes > MAX_ROOM_CONTENT_BYTES) return fail('This room reached its temporary memory limit. Save or wipe the chat to keep going.');
        Object.defineProperty(message, '_memoryBytes', { value: bytes, enumerable: false });
        room.messages.push(message);
        room.totalBytes += bytes;
        if (room.messages.length > MAX_MESSAGES_PER_ROOM) {
          const removed = room.messages.shift();
          room.totalBytes = Math.max(0, room.totalBytes - (removed._memoryBytes || 0));
        }
        this._broadcastRoom(room, 'chat:message', message);
        return { ok: true, id: message.id };
      }
      if (event === 'chat:typing') {
        this._broadcastRoom(room, 'chat:typing', { id: senderId, name: senderName, typing: Boolean(payload.typing) });
        return { ok: true };
      }
      if (event === 'chat:react') {
        if (!ALLOWED_REACTIONS.has(payload.emoji) || typeof payload.messageId !== 'string') return fail('That reaction is not supported.');
        const message = room.messages.find((item) => item.id === payload.messageId);
        if (!message) return fail('That message is no longer available.');
        if (!message.reactions[payload.emoji]) message.reactions[payload.emoji] = [];
        const users = message.reactions[payload.emoji];
        const index = users.indexOf(senderId);
        if (index >= 0) users.splice(index, 1); else users.push(senderId);
        if (!users.length) delete message.reactions[payload.emoji];
        this._broadcastRoom(room, 'chat:reaction', { messageId: message.id, reactions: message.reactions });
        return { ok: true };
      }
      if (event === 'room:wipe') {
        room.messages.length = 0;
        room.totalBytes = 0;
        this._broadcastRoom(room, 'room:wiped', { by: senderName, timestamp: Date.now() });
        return { ok: true };
      }
      return fail('Unknown action.');
    }

    _leaveRoom(callback) {
      if (this.hostRoom && this.currentRoom?.role === 'host') {
        this._endRoom('The host left. The room and its messages were cleared.', { dispatchLocal: false, notifyGuest: true });
        callback?.({ ok: true });
        return;
      }
      if (this.guestRoom && this.conn?.open) {
        this._sendRequest(this.conn, 'room:leave', {}, callback);
        return;
      }
      callback?.({ ok: true });
    }

    _endRoom(reason, { dispatchLocal = true, notifyGuest = true } = {}) {
      const room = this.hostRoom;
      if (!room || room.ending) return;
      room.ending = true;
      const conn = room.connection;
      if (notifyGuest && conn?.open) this._sendPacket(conn, { kind: 'event', event: 'room:ended', payload: { reason } });
      this.hostRoom = null;
      this.currentRoom = null;
      this.username = null;
      room.messages.length = 0;
      room.totalBytes = 0;
      room.users.clear();
      room.rateLimits.clear();
      const closeRoomTransport = () => {
        try { room.hostPeer.destroy(); } catch { /* The room host is already gone. */ }
        if (conn) { try { conn.close(); } catch { /* noop */ } }
      };
      // Flush the room-ended packet before the PeerJS room peer closes its channels.
      if (conn && notifyGuest && conn.open) window.setTimeout(closeRoomTransport, 180);
      else closeRoomTransport();
      if (dispatchLocal) this.dispatch('room:ended', { reason });
    }

    _clearGuest(closeConnection = false) {
      const conn = this.conn;
      this.conn = null;
      this.guestRoom = null;
      if (this.currentRoom?.role === 'guest') this.currentRoom = null;
      this.username = null;
      for (const [id, item] of this.pendingAcks.entries()) {
        this.pendingAcks.delete(id);
        try { item.callback(fail('The room has ended.')); } catch { /* Callback already unmounted. */ }
      }
      if (closeConnection && conn) window.setTimeout(() => { try { conn.close(); } catch { /* noop */ } }, 50);
    }

    _dispose() {
      this.manualClose = true;
      if (this.hostRoom) this._endRoom('The host closed the room. All room content was cleared.', { dispatchLocal: false, notifyGuest: true });
      if (this.guestRoom && this.conn) {
        try { this._sendPacket(this.conn, { kind: 'request', requestId: `leave-${Date.now()}`, event: 'room:leave', payload: {} }); } catch { /* Connection closure is also a signal. */ }
        try { this.conn.close(); } catch { /* noop */ }
        this._clearGuest(false);
      }
      try { this.peer?.destroy(); } catch { /* noop */ }
    }
  }

  window.io = () => new AfterglowSocket();
})();
