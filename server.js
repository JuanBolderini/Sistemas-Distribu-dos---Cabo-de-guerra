const path = require('path');
const os = require('os');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

/* ==================================================================
 * Configuracao do jogo (tema 6 - Cabo de Guerra / Clicker Duel)
 * ================================================================== */
const PORT = process.env.PORT || 3000;

const TICK_MS = 50;              // 20 ticks por segundo (agregacao dos cliques)
const STEP = 2;                  // unidades da barra por clique
const LIMIT = 100;               // fim da corda (-100 .. +100)
const COUNTDOWN_FROM = 3;        // contagem regressiva sincronizada
const GO_DELAY = 700;            // ms entre o "GO" e o inicio da partida

const MAX_CLICKS_PER_SEC = 15;   // limite de taxa por jogador (anti-autoclicker)
const RATE_NOTICE_MS = 800;      // intervalo minimo entre avisos de limite

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 4;
const NAME_MAX = 16;

/* ==================================================================
 * Log de eventos principais (RNF04)
 * ================================================================== */
function log(event, data) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const extra = data ? ' ' + JSON.stringify(data) : '';
  console.log(`[${ts}] ${event}${extra}`);
}

/* ==================================================================
 * Estado em memoria
 * ================================================================== */
const rooms = new Map();       // code -> room
const socketInfo = new Map();  // socketId -> { code, role }
const quickQueue = [];         // socketIds aguardando partida rapida

const ROLE_LABEL = { p1: 'Jogador 1', p2: 'Jogador 2', spectator: 'Espectador' };
const roleLabel = (role) => ROLE_LABEL[role] || role;

/* ==================================================================
 * Utilidades
 * ================================================================== */
function cleanName(raw) {
  const s = String(raw == null ? '' : raw)
    .replace(/[<>&"'`\\/]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX);
  return s || null;
}

function genCode() {
  let code;
  do {
    code = Array.from(
      { length: CODE_LEN },
      () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
    ).join('');
  } while (rooms.has(code));
  return code;
}

function localAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

/* ==================================================================
 * Salas
 * ================================================================== */
function createRoom() {
  const room = {
    code: genCode(),
    state: 'waiting',            // waiting | countdown | playing | ended
    players: { p1: null, p2: null },
    spectators: [],
    scores: { p1: 0, p2: 0 },
    taps: { p1: 0, p2: 0 },
    bar: 0,
    version: 0,
    ready: { p1: false, p2: false },
    timers: [],
    tick: null,
  };
  rooms.set(room.code, room);
  return room;
}

function roomSummary(room) {
  return {
    code: room.code,
    state: room.state,
    scores: { p1: room.scores.p1, p2: room.scores.p2 },
    players: {
      p1: room.players.p1 ? room.players.p1.name : null,
      p2: room.players.p2 ? room.players.p2.name : null,
    },
    spectators: room.spectators.map((s) => s.name),
    ready: { p1: room.ready.p1, p2: room.ready.p2 },
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit('room:update', roomSummary(room));
}

function addToRoom(socket, room, name) {
  let role;
  if (!room.players.p1) role = 'p1';
  else if (!room.players.p2) role = 'p2';
  else role = 'spectator';

  const player = {
    socketId: socket.id,
    name,
    role,
    clickWindow: [],
    pending: 0,
    lastRateNotice: 0,
  };

  if (role === 'spectator') room.spectators.push(player);
  else room.players[role] = player;

  if (room.state === 'ended' && (role === 'p1' || role === 'p2')) room.state = 'waiting';

  socketInfo.set(socket.id, { code: room.code, role });
  socket.data.name = name;
  socket.join(room.code);

  log('sala:entrou', { code: room.code, nome: name, papel: roleLabel(role) });

  socket.emit('room:joined', {
    code: room.code,
    roleKey: role,
    role: roleLabel(role),
    you: { name },
    ...roomSummary(room),
    match: { bar: room.bar, version: room.version, state: room.state },
  });

  broadcastRoom(room);
  maybeStart(room);
  return player;
}

function removeFromRoom(socket, reason) {
  const info = socketInfo.get(socket.id);
  socketInfo.delete(socket.id);
  if (!info) return;

  const room = rooms.get(info.code);
  if (!room) return;

  const { role } = info;
  const name = socket.data.name || 'Anônimo';
  let leftPlayer = false;

  if (role === 'spectator') {
    room.spectators = room.spectators.filter((s) => s.socketId !== socket.id);
  } else if (room.players[role] && room.players[role].socketId === socket.id) {
    room.players[role] = null;
    leftPlayer = true;
  }

  socket.leave(room.code);

  if (leftPlayer && (room.state === 'playing' || room.state === 'countdown')) {
    stopTick(room);
    clearRoomTimers(room);
    room.state = 'waiting';
    room.bar = 0;
    io.to(room.code).emit('match:aborted', { who: name, reason: 'desconexao' });
  }

  if (!room.players.p1 || !room.players.p2) {
    if (room.state === 'ended') room.state = 'waiting';
  }

  log('sala:saiu', { code: room.code, nome: name, papel: roleLabel(role), motivo: reason });

  socket.to(room.code).emit('room:peer:left', { name, role: roleLabel(role) });

  if (!room.players.p1 && !room.players.p2 && room.spectators.length === 0) {
    stopTick(room);
    clearRoomTimers(room);
    rooms.delete(room.code);
    log('sala:encerrada', { code: room.code });
  } else {
    broadcastRoom(room);
    maybeStart(room);
  }
}

/* ==================================================================
 * Partida
 * ================================================================== */
function clearRoomTimers(room) {
  room.timers.forEach(clearTimeout);
  room.timers = [];
}

function stopTick(room) {
  if (room.tick) {
    clearInterval(room.tick);
    room.tick = null;
  }
}

function maybeStart(room) {
  if (room.state === 'waiting' && room.players.p1 && room.players.p2) {
    startCountdown(room);
  }
}

function startCountdown(room) {
  stopTick(room);
  clearRoomTimers(room);

  room.state = 'countdown';
  room.bar = 0;
  room.version = 0;
  room.taps = { p1: 0, p2: 0 };
  room.ready = { p1: false, p2: false };
  if (room.players.p1) room.players.p1.pending = 0;
  if (room.players.p2) room.players.p2.pending = 0;

  log('partida:contagem', { code: room.code });

  let n = COUNTDOWN_FROM;
  io.to(room.code).emit('match:countdown', { value: n });

  const step = () => {
    n -= 1;
    if (n > 0) {
      io.to(room.code).emit('match:countdown', { value: n });
      room.timers.push(setTimeout(step, 1000));
    } else {
      io.to(room.code).emit('match:countdown', { value: 'GO' });
      room.timers.push(setTimeout(() => beginMatch(room), GO_DELAY));
    }
  };
  room.timers.push(setTimeout(step, 1000));
}

function beginMatch(room) {
  if (!room.players.p1 || !room.players.p2) {
    room.state = 'waiting';
    return;
  }
  room.state = 'playing';
  room.bar = 0;
  room.version = 0;

  io.to(room.code).emit('match:start', {
    bar: room.bar,
    version: room.version,
    taps: { ...room.taps },
    scores: { ...room.scores },
  });

  stopTick(room);
  room.tick = setInterval(() => tickMatch(room), TICK_MS);
  log('partida:iniciada', { code: room.code });
}

function tickMatch(room) {
  if (room.state !== 'playing') {
    stopTick(room);
    return;
  }

  const p1 = room.players.p1;
  const p2 = room.players.p2;
  const c1 = p1 ? p1.pending : 0;
  const c2 = p2 ? p2.pending : 0;
  if (p1) p1.pending = 0;
  if (p2) p2.pending = 0;

  if (c1 === 0 && c2 === 0) return; // nada mudou neste tick: nao transmite

  // Clicar empurra a barra para o lado do adversario:
  // ela caminha para o lado de quem clicou menos.
  room.bar += (c1 - c2) * STEP;
  if (room.bar > LIMIT) room.bar = LIMIT;
  if (room.bar < -LIMIT) room.bar = -LIMIT;
  room.version += 1;

  io.to(room.code).emit('match:update', {
    bar: room.bar,
    version: room.version,
    taps: { ...room.taps },
  });

  if (room.bar >= LIMIT || room.bar <= -LIMIT) endMatch(room);
}

function endMatch(room) {
  stopTick(room);
  clearRoomTimers(room);
  room.state = 'ended';

  const winnerKey = room.bar >= LIMIT ? 'p1' : 'p2';
  const loserKey = winnerKey === 'p1' ? 'p2' : 'p1';
  room.scores[winnerKey] += 1;

  const winner = room.players[winnerKey];
  const loser = room.players[loserKey];

  io.to(room.code).emit('match:over', {
    winnerKey,
    winnerName: winner ? winner.name : '—',
    loserName: loser ? loser.name : '—',
    bar: room.bar,
    taps: { ...room.taps },
    scores: { ...room.scores },
  });

  log('partida:encerrada', {
    code: room.code,
    vencedor: winner ? winner.name : '—',
    placar: `${room.scores.p1}x${room.scores.p2}`,
  });
}

/* ==================================================================
 * Handlers de socket (embrulhados para nao derrubar o servidor - RNF05)
 * ================================================================== */
function safeOn(socket, event, handler) {
  socket.on(event, (payload) => {
    try {
      handler(payload);
    } catch (err) {
      log('erro:handler', { evento: event, msg: String((err && err.message) || err) });
      try {
        socket.emit('error:msg', {
          code: 'INTERNAL',
          message: 'Mensagem inválida ou não suportada.',
        });
      } catch (_) {
        /* ignora falha ao responder */
      }
    }
  });
}

io.on('connection', (socket) => {
  log('conexao', { id: socket.id });

  safeOn(socket, 'room:create', (payload) => {
    const name = cleanName(payload && payload.name);
    if (!name) return socket.emit('error:msg', { code: 'NAME', message: 'Informe um apelido.' });
    if (socketInfo.has(socket.id)) return;

    const room = createRoom();
    log('sala:criada', { code: room.code, nome: name, via: 'criar' });
    addToRoom(socket, room, name);
  });

  safeOn(socket, 'room:join', (payload) => {
    const name = cleanName(payload && payload.name);
    if (!name) return socket.emit('error:msg', { code: 'NAME', message: 'Informe um apelido.' });
    if (socketInfo.has(socket.id)) return;

    const code = String((payload && payload.code) || '').trim().toUpperCase();
    if (!code) return socket.emit('error:msg', { code: 'CODE', message: 'Informe o código da sala.' });

    const room = rooms.get(code);
    if (!room) {
      log('sala:nao-encontrada', { code, nome: name });
      return socket.emit('error:msg', { code: 'NOT_FOUND', message: 'Sala não encontrada. Verifique o código.' });
    }
    addToRoom(socket, room, name);
  });

  safeOn(socket, 'match:quick', (payload) => {
    const name = cleanName(payload && payload.name);
    if (!name) return socket.emit('error:msg', { code: 'NAME', message: 'Informe um apelido.' });
    if (socketInfo.has(socket.id) || quickQueue.includes(socket.id)) return;

    socket.data.name = name;
    quickQueue.push(socket.id);
    socket.emit('quick:waiting', { name });
    log('fila:entrou', { nome: name, tamanho: quickQueue.length });

    if (quickQueue.length < 2) return;

    const aId = quickQueue.shift();
    const bId = quickQueue.shift();
    const aSocket = io.sockets.sockets.get(aId);
    const bSocket = io.sockets.sockets.get(bId);

    if (!aSocket || !bSocket) {
      if (bSocket) quickQueue.unshift(bId);
      if (aSocket) quickQueue.unshift(aId);
      return;
    }

    const room = createRoom();
    log('sala:criada', { code: room.code, via: 'partida-rapida' });
    addToRoom(aSocket, room, aSocket.data.name);
    addToRoom(bSocket, room, bSocket.data.name);
  });

  safeOn(socket, 'tap', () => {
    const info = socketInfo.get(socket.id);
    if (!info) return;

    const room = rooms.get(info.code);
    const now = Date.now();

    // RF04: jogada invalida e rejeitada com mensagem ao remetente.
    if (!room || room.state !== 'playing') {
      if (now - (socket.data.lastReject || 0) > RATE_NOTICE_MS) {
        socket.data.lastReject = now;
        socket.emit('error:msg', {
          code: 'NOT_PLAYING',
          message: 'A partida não está em andamento.',
        });
        log('jogada:rejeitada', {
          code: info.code,
          papel: roleLabel(info.role),
          motivo: room ? room.state : 'sem-sala',
        });
      }
      return;
    }

    const player = info.role === 'p1' || info.role === 'p2' ? room.players[info.role] : null;
    if (!player || player.socketId !== socket.id) {
      // espectador nao joga
      if (now - (socket.data.lastReject || 0) > RATE_NOTICE_MS) {
        socket.data.lastReject = now;
        socket.emit('error:msg', {
          code: 'SPECTATOR',
          message: 'Espectadores não podem jogar.',
        });
        log('jogada:rejeitada', { code: room.code, papel: roleLabel(info.role), motivo: 'espectador' });
      }
      return;
    }

    player.clickWindow = player.clickWindow.filter((t) => now - t < 1000);

    if (player.clickWindow.length >= MAX_CLICKS_PER_SEC) {
      if (now - player.lastRateNotice > RATE_NOTICE_MS) {
        player.lastRateNotice = now;
        socket.emit('error:msg', {
          code: 'RATE_LIMIT',
          message: `Limite de ${MAX_CLICKS_PER_SEC} cliques/s atingido (anti-autoclicker).`,
        });
        log('jogada:rejeitada', { code: room.code, nome: player.name, motivo: 'rate-limit' });
      }
      return;
    }

    player.clickWindow.push(now);
    player.pending += 1;
    room.taps[info.role] += 1;
  });

  safeOn(socket, 'rematch:request', () => {
    const info = socketInfo.get(socket.id);
    if (!info || info.role === 'spectator') return;

    const room = rooms.get(info.code);
    if (!room || room.state !== 'ended') return;

    room.ready[info.role] = true;
    log('revanche:solicitada', { code: room.code, papel: roleLabel(info.role) });
    broadcastRoom(room);

    if (room.ready.p1 && room.ready.p2) startCountdown(room);
  });

  // Reinicia a partida a qualquer momento; exige os dois jogadores na sala.
  safeOn(socket, 'match:restart', () => {
    const info = socketInfo.get(socket.id);
    if (!info || info.role === 'spectator') return;

    const room = rooms.get(info.code);
    if (!room || !room.players.p1 || !room.players.p2) return;

    log('partida:reiniciada', { code: room.code, papel: roleLabel(info.role) });
    startCountdown(room);
  });

  safeOn(socket, 'room:leave', () => {
    const qi = quickQueue.indexOf(socket.id);
    if (qi !== -1) {
      quickQueue.splice(qi, 1);
      log('fila:saiu', { nome: socket.data.name || '—' });
    }
    removeFromRoom(socket, 'saiu');
    socket.emit('room:left');
  });

  socket.on('disconnect', (reason) => {
    const qi = quickQueue.indexOf(socket.id);
    if (qi !== -1) quickQueue.splice(qi, 1);
    log('desconexao', { id: socket.id, motivo: reason });
    removeFromRoom(socket, 'desconexao');
  });
});

/* ==================================================================
 * Start
 * ================================================================== */
server.listen(PORT, () => {
  const addrs = localAddresses();
  console.log('\n  🪢  Cabo de Guerra Online — servidor ativo');
  console.log(`      Local:   http://localhost:${PORT}`);
  addrs.forEach((ip) => console.log(`      Rede:    http://${ip}:${PORT}`));
  console.log(`      Ticks:   ${1000 / TICK_MS}/s | Limite: ${MAX_CLICKS_PER_SEC} cliques/s por jogador\n`);
});
