/* global io */
const socket = io();
const $ = (sel) => document.querySelector(sel);

const state = {
  name: '',
  code: null,
  roleKey: null,          // 'p1' | 'p2' | 'spectator'
  role: null,             // 'Jogador 1' | 'Jogador 2' | 'Espectador'
  room: null,             // resumo da sala (room:update / room:joined)
  phase: 'lobby',         // lobby | queue | waiting | countdown | playing | ended
  bar: 0,                 // -100 (lado J1) .. +100 (lado J2)
  taps: { p1: 0, p2: 0 },
  scores: { p1: 0, p2: 0 },
  ready: { p1: false, p2: false },
  iRequested: false,
};

const isPlayer = () => state.roleKey === 'p1' || state.roleKey === 'p2';
const opSlot = () => (state.roleKey === 'p1' ? 'p2' : 'p1');

/* ------------------------------------------------------------------ *
 * Helpers de tela
 * ------------------------------------------------------------------ */
function show(id) {
  document.querySelectorAll('.screen').forEach((el) => {
    el.classList.toggle('active', el.id === 'screen-' + id);
  });
}
function currentScreen() {
  const el = document.querySelector('.screen.active');
  return el ? el.id : null;
}

let toastTimer;
function toast(msg, isErr) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('err', !!isErr);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

/* Cada jogador se ve sempre do lado esquerdo. */
function perspective() {
  const players = (state.room && state.room.players) || { p1: null, p2: null };
  if (state.roleKey === 'p2') {
    return { left: 'p2', right: 'p1', leftName: players.p2, rightName: players.p1 };
  }
  return { left: 'p1', right: 'p2', leftName: players.p1, rightName: players.p2 };
}

function displayPct(bar) {
  const norm = (bar + 100) / 2;              // 0 = lado J1, 100 = lado J2
  return state.roleKey === 'p2' ? 100 - norm : norm;
}

/* ------------------------------------------------------------------ *
 * Renderizacao
 * ------------------------------------------------------------------ */
function renderBar() {
  const pct = displayPct(state.bar);
  const knot = $('#knot');
  knot.style.left = pct + '%';
  knot.classList.toggle('danger-me', pct <= 15);
  knot.classList.toggle('danger-op', pct >= 85);
}

function renderTaps() {
  const p = perspective();
  $('#taps-me').textContent = state.taps[p.left] || 0;
  $('#taps-op').textContent = state.taps[p.right] || 0;
}

function scoreText() {
  const s = state.scores;
  return state.roleKey === 'p2' ? `Placar ${s.p2} × ${s.p1}` : `Placar ${s.p1} × ${s.p2}`;
}

function renderHud() {
  const p = perspective();
  $('#name-me').textContent = p.leftName || '—';
  $('#label-me').textContent = p.leftName || '—';
  $('#name-op').textContent = p.rightName || '—';
  $('#label-op').textContent = p.rightName || '—';
  renderTaps();
  $('#game-score').textContent = scoreText();
}

function updateGameStatus() {
  const labels = {
    waiting: 'Aguardando oponente',
    countdown: 'Contagem regressiva',
    playing: 'Em combate',
    ended: 'Fim de partida',
  };
  $('#game-status').textContent = labels[state.phase] || state.phase;
}

function applyRoleUI() {
  const player = isPlayer();
  $('#tug-btn').classList.toggle('hidden', !player);
  $('#btn-restart').classList.toggle('hidden', !player);
  $('#game-hint').innerHTML = player
    ? 'Clique no botão, na arena ou aperte <kbd>Espaço</kbd>'
    : 'Você é espectador — assista à partida';
}

function renderRoom() {
  const room = state.room;
  if (!room) return;

  $('#room-code').textContent = room.code;
  $('#room-role').textContent = 'Você é ' + state.role;

  const p1 = room.players.p1;
  const p2 = room.players.p2;
  const ready = !!(p1 && p2);

  const status = $('#room-status');
  status.textContent = ready ? 'Pronto! Iniciando a partida…' : 'Aguardando oponente';
  status.classList.toggle('ok', ready);

  [['p1', p1], ['p2', p2]].forEach(([slot, name]) => {
    const el = $('#slot-' + slot);
    el.querySelector('.slot-name').textContent = name || 'aguardando…';
    el.classList.toggle('filled', !!name);
  });

  const spec = room.spectators || [];
  $('#spectators').textContent = spec.length ? `Espectadores (${spec.length}): ${spec.join(', ')}` : '';
  $('#scoreline').textContent = `Placar da sessão: ${room.scores.p1} × ${room.scores.p2}`;
}

function renderAgainButton() {
  const btn = $('#btn-again');
  if (!isPlayer()) {
    btn.style.display = 'none';
    return;
  }
  btn.style.display = '';
  if (state.iRequested) {
    btn.disabled = true;
    btn.textContent = 'Aguardando oponente…';
  } else if (state.ready && state.ready[opSlot()]) {
    btn.disabled = false;
    btn.textContent = 'Oponente quer revanche — aceitar';
  } else {
    btn.disabled = false;
    btn.textContent = 'Jogar novamente';
  }
}

function enterGame() {
  applyRoleUI();
  renderHud();
  renderBar();
  updateGameStatus();
  $('#overlay-result').classList.remove('show');
  show('game');
}

function resetToLobby() {
  state.code = null;
  state.roleKey = null;
  state.role = null;
  state.room = null;
  state.phase = 'lobby';
  state.bar = 0;
  state.taps = { p1: 0, p2: 0 };
  state.iRequested = false;
  $('#overlay-countdown').classList.remove('show');
  $('#overlay-result').classList.remove('show');
  show('lobby');
}

/* ------------------------------------------------------------------ *
 * Lobby
 * ------------------------------------------------------------------ */
function nameOrWarn() {
  const name = $('#input-name').value.trim().slice(0, 16);
  if (!name) {
    toast('Digite um apelido para começar.', true);
    $('#input-name').focus();
    return null;
  }
  state.name = name;
  return name;
}

$('#btn-create').addEventListener('click', () => {
  const name = nameOrWarn();
  if (name) socket.emit('room:create', { name });
});

$('#btn-join').addEventListener('click', joinByCode);
$('#input-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinByCode();
});
function joinByCode() {
  const name = nameOrWarn();
  if (!name) return;
  const code = $('#input-code').value.trim().toUpperCase();
  if (!code) {
    toast('Digite o código da sala.', true);
    $('#input-code').focus();
    return;
  }
  socket.emit('room:join', { name, code });
}

$('#btn-quick').addEventListener('click', () => {
  const name = nameOrWarn();
  if (name) socket.emit('match:quick', { name });
});

$('#btn-queue-cancel').addEventListener('click', () => {
  socket.emit('room:leave');
  resetToLobby();
});

/* ------------------------------------------------------------------ *
 * Sala de espera
 * ------------------------------------------------------------------ */
$('#btn-room-leave').addEventListener('click', () => socket.emit('room:leave'));

// Reinicia a partida sem esperar o fim (somente jogadores).
$('#btn-restart').addEventListener('click', () => {
  if (isPlayer()) socket.emit('match:restart');
});

// Abandona a sala a qualquer momento e volta ao início.
$('#btn-home').addEventListener('click', () => socket.emit('room:leave'));

$('#btn-copy').addEventListener('click', () => {
  const code = state.code || '';
  if (!code) return;
  const done = () => toast('Código copiado: ' + code);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(code).then(done).catch(() => fallbackCopy(code, done));
  } else {
    fallbackCopy(code, done);
  }
});
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    done();
  } catch (_) {
    toast('Copie o código manualmente: ' + text, true);
  }
  document.body.removeChild(ta);
}

/* ------------------------------------------------------------------ *
 * Cliques no jogo
 * ------------------------------------------------------------------ */
function tap() {
  if (state.phase !== 'playing' || !isPlayer()) return;
  socket.emit('tap');
  const btn = $('#tug-btn');
  btn.classList.remove('press');
  void btn.offsetWidth;
  btn.classList.add('press');
}

$('#tug-btn').addEventListener('click', tap);
$('#arena').addEventListener('click', tap);
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' && e.key !== ' ') return;
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
  e.preventDefault();
  tap();
});

/* ------------------------------------------------------------------ *
 * Eventos do servidor
 * ------------------------------------------------------------------ */
socket.on('quick:waiting', ({ name }) => {
  state.phase = 'queue';
  $('#queue-name').textContent = name;
  show('queue');
});

socket.on('room:joined', (data) => {
  state.code = data.code;
  state.roleKey = data.roleKey;
  state.role = data.role;
  state.room = data;
  state.scores = data.scores;
  state.ready = data.ready;
  state.bar = data.match.bar;
  state.phase = data.match.state;
  state.iRequested = false;

  $('#overlay-countdown').classList.remove('show');
  $('#overlay-result').classList.remove('show');

  if (data.match.state === 'playing' || data.match.state === 'countdown') {
    enterGame();
  } else {
    renderRoom();
    show('room');
  }
});

socket.on('room:update', (data) => {
  state.room = data;
  state.scores = data.scores;
  state.ready = data.ready;
  if (currentScreen() === 'screen-room') renderRoom();
  if (state.roleKey) {
    renderHud();
    updateGameStatus();
    renderAgainButton();
  }
});

socket.on('room:peer:left', ({ name, role }) => {
  toast(`${name} (${role}) saiu da sala.`);
});

socket.on('room:left', () => resetToLobby());

socket.on('match:countdown', ({ value }) => {
  state.phase = 'countdown';
  state.iRequested = false;
  show('game');
  applyRoleUI();
  updateGameStatus();
  renderAgainButton();
  $('#overlay-result').classList.remove('show');

  const overlay = $('#overlay-countdown');
  overlay.classList.add('show');
  const el = $('#countdown-value');
  el.textContent = value;
  el.classList.toggle('go', value === 'GO');
  el.classList.remove('pop');
  void el.offsetWidth;
  el.classList.add('pop');
});

socket.on('match:start', (data) => {
  state.phase = 'playing';
  state.bar = data.bar;
  state.taps = data.taps;
  state.scores = data.scores;
  state.iRequested = false;
  $('#overlay-countdown').classList.remove('show');
  enterGame();
});

socket.on('match:update', (data) => {
  state.bar = data.bar;
  state.taps = data.taps;
  renderBar();
  renderTaps();
});

socket.on('match:over', (data) => {
  state.phase = 'ended';
  state.bar = data.bar;
  state.taps = data.taps;
  state.scores = data.scores;
  state.iRequested = false;

  renderBar();
  renderHud();
  updateGameStatus();

  let title;
  let sub;
  if (!isPlayer()) {
    title = 'Fim de partida';
    sub = `${data.winnerName} venceu ${data.loserName}.`;
  } else if (data.winnerKey === state.roleKey) {
    title = '🎉 Você venceu!';
    sub = `Você clicou mais e arrastou ${data.loserName} até o fim!`;
  } else {
    title = '😵 Você perdeu';
    sub = `${data.winnerName} clicou mais. Tente de novo!`;
  }

  $('#result-title').textContent = title;
  $('#result-sub').textContent = sub;
  renderAgainButton();
  $('#overlay-result').classList.add('show');
});

socket.on('match:aborted', ({ who }) => {
  state.phase = 'waiting';
  state.bar = 0;
  state.iRequested = false;
  $('#overlay-countdown').classList.remove('show');
  $('#overlay-result').classList.remove('show');
  renderBar();
  renderRoom();
  show('room');
  toast(`${who} desconectou. A partida foi encerrada.`, true);
});

socket.on('error:msg', ({ message }) => toast(message, true));

/* ------------------------------------------------------------------ *
 * Resultado / revanche
 * ------------------------------------------------------------------ */
$('#btn-again').addEventListener('click', () => {
  if (!isPlayer()) return;
  socket.emit('rematch:request');
  state.iRequested = true;
  renderAgainButton();
});

$('#btn-lobby').addEventListener('click', () => socket.emit('room:leave'));
