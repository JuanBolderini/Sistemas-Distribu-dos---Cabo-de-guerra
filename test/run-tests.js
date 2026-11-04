'use strict';

/*
 * Testes automatizados do servidor autoritativo (Cabo de Guerra Online).
 * Cobrem o roteiro de testes da secao 9 do plano da disciplina.
 *
 * Uso:  npm test
 */

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const assert = require('assert');
const { io } = require('socket.io-client');

const PORT = Number(process.env.TEST_PORT || 4173);
const HOST = 'localhost';
const URL = `http://${HOST}:${PORT}`;
const ROOT = path.join(__dirname, '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================================================================== *
 * Mini-harness
 * ================================================================== */
const outcomes = [];
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    outcomes.push({ name, ok: true });
    console.log(`  \u2713 ${name}  (${Date.now() - t0}ms)`);
  } catch (err) {
    outcomes.push({ name, ok: false, err });
    console.log(`  \u2717 ${name}`);
    console.log(`      ${(err && err.message) || err}`);
  }
}

/* ================================================================== *
 * Helpers de socket
 * ================================================================== */
function connect() {
  return new Promise((resolve, reject) => {
    const s = io(URL, { forceNew: true, transports: ['websocket'], reconnection: false });
    const t = setTimeout(() => reject(new Error('timeout ao conectar')), 4000);
    s.once('connect', () => {
      clearTimeout(t);
      resolve(s);
    });
    s.once('connect_error', (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

// Registra todos os eventos recebidos por um socket, sem perder nenhum.
function record(socket) {
  const log = [];
  const original = socket.onevent;
  socket.onevent = function (packet) {
    const data = (packet && packet.data) || [];
    log.push({ event: data[0], args: data.slice(1), t: Date.now() });
    original.call(this, packet);
  };
  return log;
}

const countOf = (log, ev) => log.filter((e) => e.event === ev).length;

async function waitCount(log, ev, n, timeout = 9000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const items = log.filter((e) => e.event === ev);
    if (items.length >= n) return items[n - 1].args[0];
    await sleep(20);
  }
  throw new Error(`timeout esperando '${ev}' (#${n})`);
}

// Espera por uma NOVA ocorrencia do evento (a partir do momento da chamada).
function waitNew(log, ev, timeout = 9000) {
  return waitCount(log, ev, countOf(log, ev) + 1, timeout);
}

function httpGet(p) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: HOST, port: PORT, path: p }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject);
  });
}

/* ================================================================== *
 * Ciclo de vida do servidor
 * ================================================================== */
function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const onData = (d) => {
      out += d.toString();
      if (/servidor ativo/.test(out)) resolve(child);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => reject(new Error(`servidor encerrou (${code})\n${out}`)));
    setTimeout(() => reject(new Error(`timeout ao iniciar o servidor\n${out}`)), 9000);
  });
}

/* ================================================================== *
 * Suite
 * ================================================================== */
async function main() {
  const server = await startServer();
  const open = [];
  const track = (s) => {
    open.push(s);
    return s;
  };
  const ctx = {};

  console.log('\nCabo de Guerra Online — testes do servidor\n');

  await test('C1/9.1  HTTP serve a interface (servidor ativo)', async () => {
    const res = await httpGet('/');
    assert.strictEqual(res.status, 200);
    assert.ok(/Cabo de Guerra/.test(res.body), 'index.html nao servido');
  });

  /* -------- Sala, papeis e jogadas invalidas -------- */
  await test('9.2/RF02  criador entra como Jogador 1', async () => {
    ctx.p1 = track(await connect());
    ctx.l1 = record(ctx.p1);
    const joined = waitNew(ctx.l1, 'room:joined');
    ctx.p1.emit('room:create', { name: 'Ana' });
    const j = await joined;
    assert.strictEqual(j.roleKey, 'p1');
    assert.strictEqual(j.role, 'Jogador 1');
    assert.match(j.code, /^[A-Z2-9]{4}$/, 'codigo de sala invalido');
    ctx.code = j.code;
  });

  await test('RF04  jogada fora de partida e rejeitada', async () => {
    const rej = waitNew(ctx.l1, 'error:msg');
    ctx.p1.emit('tap');
    const r = await rej;
    assert.strictEqual(r.code, 'NOT_PLAYING');
  });

  await test('RF04  sala inexistente retorna erro', async () => {
    const s = track(await connect());
    const l = record(s);
    const rej = waitNew(l, 'error:msg');
    s.emit('room:join', { name: 'X', code: 'ZZZZ' });
    const r = await rej;
    assert.strictEqual(r.code, 'NOT_FOUND');
  });

  await test('9.2/RF02  segundo entra como Jogador 2', async () => {
    ctx.p2 = track(await connect());
    ctx.l2 = record(ctx.p2);
    const startP = waitNew(ctx.l1, 'match:start', 12000);
    const joinedP = waitNew(ctx.l2, 'room:joined');
    ctx.p2.emit('room:join', { name: 'Bia', code: ctx.code });
    const j = await joinedP;
    assert.strictEqual(j.roleKey, 'p2');
    assert.strictEqual(j.role, 'Jogador 2');
    ctx.firstStart = await startP; // contagem regressiva -> inicio
    assert.strictEqual(ctx.firstStart.bar, 0);
  });

  await test('RF05  roster sincronizado na sala', async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 4000) {
      const u = ctx.l1
        .map((e) => e.args[0])
        .filter(Boolean)
        .reverse()
        .find((x) => x.players && x.players.p2 === 'Bia');
      if (u) {
        assert.strictEqual(u.players.p1, 'Ana');
        return;
      }
      await sleep(20);
    }
    throw new Error('room:update com o roster completo nao chegou');
  });

  await test('9.3/RF02  terceiro entra como Espectador', async () => {
    ctx.spec = track(await connect());
    ctx.ls = record(ctx.spec);
    const joined = waitNew(ctx.ls, 'room:joined');
    ctx.spec.emit('room:join', { name: 'Carlos', code: ctx.code });
    const j = await joined;
    assert.strictEqual(j.roleKey, 'spectator');
    assert.strictEqual(j.role, 'Espectador');
  });

  await test('9.5/RF04  espectador nao pode jogar', async () => {
    const rej = waitNew(ctx.ls, 'error:msg');
    ctx.spec.emit('tap');
    const r = await rej;
    assert.strictEqual(r.code, 'SPECTATOR');
  });

  /* -------- Tema 6: agregacao em ticks + rate limit -------- */
  await test('Tema6  agregacao em ticks move a barra (RF05)', async () => {
    const updP = waitNew(ctx.l2, 'match:update'); // o oponente tambem ve
    for (let i = 0; i < 5; i++) ctx.p1.emit('tap');
    const u = await updP;
    assert.ok(u.version >= 1, 'versao deve crescer');
    assert.strictEqual(u.taps.p1, 5);
    assert.ok(u.bar > 0, 'barra deve ir para o lado do adversario de quem clicou mais');
    ctx.barAfter5 = u.bar;
  });

  await test('Tema6  limite de taxa neutraliza autoclicker', async () => {
    const rej = waitNew(ctx.l1, 'error:msg');
    for (let i = 0; i < 40; i++) ctx.p1.emit('tap'); // rajada de autoclicker
    const r = await rej;
    assert.strictEqual(r.code, 'RATE_LIMIT');
  });

  /* -------- Partida completa -------- */
  await test('9.4/RF06  partida completa com resultado correto', async () => {
    const overP = waitNew(ctx.l1, 'match:over', 15000);
    const spam = setInterval(() => ctx.p1.emit('tap'), 70); // ~14 cliques/s
    let over;
    try {
      over = await overP;
    } finally {
      clearInterval(spam);
    }
    assert.strictEqual(over.winnerKey, 'p1');
    assert.strictEqual(over.winnerName, 'Ana');
    assert.strictEqual(over.bar, 100);
    assert.strictEqual(over.scores.p1, 1);
    assert.strictEqual(over.scores.p2, 0);
    ctx.over = over;
  });

  /* -------- Revanche (RF08) -------- */
  await test('9.9/RF08  revanche mantem o placar da sessao', async () => {
    const startP = waitNew(ctx.l1, 'match:start', 15000);
    ctx.p1.emit('rematch:request');
    ctx.p2.emit('rematch:request');
    const s = await startP;
    assert.strictEqual(s.scores.p1, 1, 'placar da sessao perdido');
    assert.strictEqual(s.bar, 0);
  });

  /* -------- Desconexao (RF07) -------- */
  await test('9.8/RF07  desconexao aborta a partida e libera a sala', async () => {
    const abortP = waitNew(ctx.l1, 'match:aborted');
    const peerP = waitNew(ctx.l1, 'room:peer:left');
    ctx.p2.disconnect();
    const a = await abortP;
    assert.strictEqual(a.who, 'Bia');
    const peer = await peerP;
    assert.strictEqual(peer.name, 'Bia');
  });

  await test('9.8/RF07  servidor continua ativo apos a desconexao', async () => {
    const res = await httpGet('/');
    assert.strictEqual(res.status, 200);
    const s = track(await connect());
    const l = record(s);
    const joined = waitNew(l, 'room:joined');
    s.emit('room:create', { name: 'Novo' });
    const j = await joined;
    assert.strictEqual(j.roleKey, 'p1');
  });

  /* -------- Isolamento entre salas -------- */
  await test('9.7  duas partidas simultaneas nao interferem', async () => {
    async function pair(n1, n2) {
      const a = track(await connect());
      const b = track(await connect());
      const la = record(a);
      const lb = record(b);
      const j1 = waitNew(la, 'room:joined');
      a.emit('room:create', { name: n1 });
      const info = await j1;
      const startP = waitNew(la, 'match:start', 12000);
      const j2 = waitNew(lb, 'room:joined');
      b.emit('room:join', { name: n2, code: info.code });
      await j2;
      await startP;
      return { a, b, la, lb, code: info.code };
    }

    const roomA = await pair('A1', 'A2');
    const roomB = await pair('B1', 'B2');

    const updA = waitNew(roomA.la, 'match:update');
    for (let i = 0; i < 6; i++) roomA.a.emit('tap');
    const u = await updA;
    assert.ok(u.bar > 0);

    await sleep(300); // tempo para qualquer vazamento aparecer
    assert.strictEqual(countOf(roomB.la, 'match:update'), 0, 'vazou para a sala B');
    assert.strictEqual(countOf(roomB.lb, 'match:update'), 0, 'vazou para a sala B');

    [roomA.a, roomA.b, roomB.a, roomB.b].forEach((s) => s.disconnect());
  });

  /* -------- Robustez (RNF05) -------- */
  await test('RNF05  mensagens malformadas nao derrubam o servidor', async () => {
    const s = track(await connect());
    const l = record(s);
    const rej = waitNew(l, 'error:msg');
    s.emit('room:create', 12345); // payload com tipo inesperado
    const r = await rej;
    assert.strictEqual(r.code, 'NAME');

    s.emit('room:join', null);
    s.emit('tap');
    s.emit('evento:desconhecido', { foo: 'bar' });
    s.emit('rematch:request');
    await sleep(250);

    const res = await httpGet('/');
    assert.strictEqual(res.status, 200, 'servidor caiu com entrada malformada');
  });

  await test('RNF05/RF02  nome com HTML e saneado (anti-XSS)', async () => {
    const s = track(await connect());
    const l = record(s);
    const joined = waitNew(l, 'room:joined');
    s.emit('room:create', { name: '<b>Bob</b>' });
    const j = await joined;
    assert.ok(!/[<>]/.test(j.you.name), `nome nao saneado: ${j.you.name}`);
    assert.ok(/Bob/.test(j.you.name), `nome inesperado: ${j.you.name}`);
  });

  /* -------- Encerramento -------- */
  open.forEach((s) => {
    try {
      s.disconnect();
    } catch (_) {
      /* ignora */
    }
  });
  server.kill();

  const failed = outcomes.filter((o) => !o.ok);
  console.log(`\n${outcomes.length - failed.length}/${outcomes.length} cenarios OK\n`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => {
  console.error('\nFalha fatal na execucao dos testes:', err);
  process.exitCode = 1;
});
