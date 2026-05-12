/**
 * Multiplayer Electrolyte Quiz — Express + ws server.
 *
 * Rooms live in memory. Up to 3 players per room. WebSocket protocol below.
 *
 * --- Client → Server messages ---
 *   { type:'join', room:'ABC123', name:'Alice' }
 *   { type:'start' }                          // host only
 *   { type:'answer', choice:0..3 }            // during a question
 *   { type:'next' }                           // host only — advance after explanation
 *   { type:'restart' }                        // host only — return to lobby
 *   { type:'ping' }
 *
 * --- Server → Client messages ---
 *   { type:'joined', you:{seat,name,isHost}, room:{code, players, phase} }
 *   { type:'state', room:{...} }              // full room state broadcast
 *   { type:'question', index, total, scenario, question, options, deadlineTs }
 *   { type:'answered', seat }                 // someone locked an answer
 *   { type:'reveal', correct:0..3, explanation, scores, perPlayer:[{seat,choice,correct}] }
 *   { type:'final', ranking:[{seat,name,score,rank}] }
 *   { type:'error', code, message }
 *   { type:'pong' }
 *
 * Phases: 'lobby' | 'question' | 'reveal' | 'final'
 *
 * In-memory only; rooms vanish on restart.
 */

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { QUESTION_BANK } = require('./questions.js');

const PORT = parseInt(process.env.PORT || '5000', 10);
const MAX_PLAYERS = 3;
const QUESTIONS_PER_MATCH = parseInt(process.env.QUESTIONS_PER_MATCH || '20', 10);
const QUESTION_DURATION_MS = parseInt(process.env.QUESTION_DURATION_MS || '20000', 10);
const REVEAL_DURATION_MS = parseInt(process.env.REVEAL_DURATION_MS || '6000', 10);
const POINTS_CORRECT = 5;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

/** @type {Map<string, Room>} */
const rooms = new Map();

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function randomizeOptions(q) {
  const originalAnswer = q.answer;
  const indices = q.options.map((_, i) => i);
  const shuffledIndices = shuffle(indices);
  const options = shuffledIndices.map(i => q.options[i]);
  const answer = shuffledIndices.indexOf(originalAnswer);
  return { ...q, options, answer };
}

function pickQuestions(n) {
  return shuffle(QUESTION_BANK).slice(0, n).map(randomizeOptions);
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(msg)); } catch (_) {}
  }
}

function broadcast(room, msg) {
  for (const p of room.players) {
    if (p && p.ws) send(p.ws, msg);
  }
}

function publicRoomState(room) {
  return {
    code: room.code,
    phase: room.phase,
    questionIndex: room.questionIndex,
    totalQuestions: room.questions.length || QUESTIONS_PER_MATCH,
    hostSeat: room.hostSeat,
    players: room.players.map((p, i) =>
      p ? {
        seat: i,
        name: p.name,
        score: p.score,
        connected: !!(p.ws && p.ws.readyState === 1),
        hasAnswered: room.phase === 'question' ? p.currentChoice !== null : false,
        isHost: i === room.hostSeat,
      } : null
    ),
  };
}

function broadcastState(room) {
  broadcast(room, { type: 'state', room: publicRoomState(room) });
}

/* ------------------------------------------------------------------ */
/* Room lifecycle                                                     */
/* ------------------------------------------------------------------ */

function getOrCreateRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    room = {
      code,
      players: [null, null, null], // seat indices 0..2
      phase: 'lobby',
      hostSeat: null,
      questions: [],
      questionIndex: -1,
      questionTimer: null,
      revealTimer: null,
      questionDeadline: 0,
    };
    rooms.set(code, room);
  }
  return room;
}

function findFreeSeat(room) {
  for (let i = 0; i < MAX_PLAYERS; i++) if (!room[i] && !room.players[i]) return i;
  return -1;
}

function deleteIfEmpty(room) {
  const anyConnected = room.players.some(p => p && p.ws && p.ws.readyState === 1);
  if (!anyConnected) {
    if (room.questionTimer) clearTimeout(room.questionTimer);
    if (room.revealTimer) clearTimeout(room.revealTimer);
    rooms.delete(room.code);
  }
}

/* ------------------------------------------------------------------ */
/* Game state machine                                                 */
/* ------------------------------------------------------------------ */

function startGame(room) {
  if (room.phase !== 'lobby') return;
  const activePlayers = room.players.filter(p => p);
  if (activePlayers.length < 1) return;
  room.questions = pickQuestions(QUESTIONS_PER_MATCH);
  room.questionIndex = -1;
  for (const p of room.players) if (p) p.score = 0;
  advanceQuestion(room);
}

function advanceQuestion(room) {
  if (room.questionTimer) { clearTimeout(room.questionTimer); room.questionTimer = null; }
  if (room.revealTimer) { clearTimeout(room.revealTimer); room.revealTimer = null; }
  room.questionIndex += 1;
  if (room.questionIndex >= room.questions.length) {
    finishGame(room);
    return;
  }
  for (const p of room.players) {
    if (p) { p.currentChoice = null; p.lockedAt = 0; }
  }
  room.phase = 'question';
  room.questionDeadline = Date.now() + QUESTION_DURATION_MS;
  const q = room.questions[room.questionIndex];
  broadcast(room, {
    type: 'question',
    index: room.questionIndex,
    total: room.questions.length,
    scenario: q.scenario,
    question: q.question,
    options: q.options,
    category: q.category,
    deadlineTs: room.questionDeadline,
  });
  broadcastState(room);
  room.questionTimer = setTimeout(() => resolveQuestion(room, true), QUESTION_DURATION_MS + 50);
}

function maybeResolveEarly(room) {
  if (room.phase !== 'question') return;
  const active = room.players.filter(p => p);
  if (active.length === 0) return;
  const allAnswered = active.every(p => p.currentChoice !== null);
  if (allAnswered) resolveQuestion(room, false);
}

function resolveQuestion(room, byTimeout) {
  if (room.phase !== 'question') return;
  if (room.questionTimer) { clearTimeout(room.questionTimer); room.questionTimer = null; }
  const q = room.questions[room.questionIndex];
  const correct = q.answer;
  const perPlayer = [];
  for (let i = 0; i < room.players.length; i++) {
    const p = room.players[i];
    if (!p) continue;
    const choice = p.currentChoice;
    const isCorrect = choice === correct;
    if (isCorrect) p.score += POINTS_CORRECT;
    perPlayer.push({ seat: i, choice, correct: isCorrect });
  }
  room.phase = 'reveal';
  broadcast(room, {
    type: 'reveal',
    correct,
    explanation: q.explanation,
    perPlayer,
    scores: room.players.map(p => p ? p.score : null),
    byTimeout,
  });
  broadcastState(room);
  room.revealTimer = setTimeout(() => advanceQuestion(room), REVEAL_DURATION_MS);
}

function finishGame(room) {
  room.phase = 'final';
  if (room.questionTimer) { clearTimeout(room.questionTimer); room.questionTimer = null; }
  if (room.revealTimer) { clearTimeout(room.revealTimer); room.revealTimer = null; }
  const players = room.players
    .map((p, i) => p ? { seat: i, name: p.name, score: p.score } : null)
    .filter(Boolean);
  const sorted = players.slice().sort((a, b) => b.score - a.score);
  // dense rank with ties
  const ranking = [];
  let lastScore = null;
  let lastRank = 0;
  for (let i = 0; i < sorted.length; i++) {
    const item = sorted[i];
    if (item.score !== lastScore) {
      lastRank = i + 1;
      lastScore = item.score;
    }
    ranking.push({ ...item, rank: lastRank });
  }
  broadcast(room, { type: 'final', ranking });
  broadcastState(room);
}

function restartLobby(room) {
  if (room.questionTimer) { clearTimeout(room.questionTimer); room.questionTimer = null; }
  if (room.revealTimer) { clearTimeout(room.revealTimer); room.revealTimer = null; }
  room.phase = 'lobby';
  room.questions = [];
  room.questionIndex = -1;
  for (const p of room.players) if (p) { p.score = 0; p.currentChoice = null; }
  broadcastState(room);
}

/* ------------------------------------------------------------------ */
/* WebSocket handlers                                                 */
/* ------------------------------------------------------------------ */

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.player = null;
  ws.roomCode = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    if (!msg || typeof msg.type !== 'string') return;
    handleMessage(ws, msg);
  });

  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', () => {});
});

function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'ping': return send(ws, { type: 'pong' });
    case 'join': return handleJoin(ws, msg);
    case 'start': return handleStart(ws);
    case 'answer': return handleAnswer(ws, msg);
    case 'next': return handleNext(ws);
    case 'restart': return handleRestart(ws);
    default: send(ws, { type: 'error', code: 'unknown', message: 'unknown message' });
  }
}

function handleJoin(ws, msg) {
  const code = String(msg.room || '').trim().toUpperCase().slice(0, 16);
  let name = String(msg.name || '').trim().slice(0, 20);
  if (!code) return send(ws, { type: 'error', code: 'badroom', message: '請輸入房間密碼' });
  const room = getOrCreateRoom(code);

  // If the game is in progress, become spectator? Simpler: reject when full or game started.
  if (room.phase !== 'lobby') {
    return send(ws, { type: 'error', code: 'inprogress', message: '此房間遊戲已開始，請等待下一輪。' });
  }

  const seat = findFreeSeat(room);
  if (seat < 0) {
    return send(ws, { type: 'error', code: 'full', message: '房間已滿（最多 3 人）' });
  }
  if (!name) name = `玩家 ${seat + 1}`;

  const player = {
    seat, name, ws, score: 0, currentChoice: null, lockedAt: 0,
  };
  room.players[seat] = player;
  ws.player = player;
  ws.roomCode = code;
  if (room.hostSeat === null) room.hostSeat = seat;

  send(ws, {
    type: 'joined',
    you: { seat, name, isHost: room.hostSeat === seat },
    room: publicRoomState(room),
  });
  broadcastState(room);
}

function handleStart(ws) {
  const room = ws.roomCode && rooms.get(ws.roomCode);
  if (!room || !ws.player) return;
  if (ws.player.seat !== room.hostSeat) {
    return send(ws, { type: 'error', code: 'nothost', message: '只有房主可開始遊戲' });
  }
  if (room.phase !== 'lobby') return;
  startGame(room);
}

function handleAnswer(ws, msg) {
  const room = ws.roomCode && rooms.get(ws.roomCode);
  if (!room || !ws.player) return;
  if (room.phase !== 'question') return;
  const choice = msg.choice;
  if (!Number.isInteger(choice) || choice < 0 || choice > 3) return;
  if (ws.player.currentChoice !== null) return; // locked
  ws.player.currentChoice = choice;
  ws.player.lockedAt = Date.now();
  broadcast(room, { type: 'answered', seat: ws.player.seat });
  broadcastState(room);
  maybeResolveEarly(room);
}

function handleNext(ws) {
  // currently advance is automatic; keep for forward-compat
  const room = ws.roomCode && rooms.get(ws.roomCode);
  if (!room || !ws.player) return;
  if (ws.player.seat !== room.hostSeat) return;
  if (room.phase !== 'reveal') return;
  if (room.revealTimer) { clearTimeout(room.revealTimer); room.revealTimer = null; }
  advanceQuestion(room);
}

function handleRestart(ws) {
  const room = ws.roomCode && rooms.get(ws.roomCode);
  if (!room || !ws.player) return;
  if (ws.player.seat !== room.hostSeat) return;
  restartLobby(room);
}

function handleDisconnect(ws) {
  if (!ws.roomCode || !ws.player) return;
  const room = rooms.get(ws.roomCode);
  if (!room) return;
  const seat = ws.player.seat;
  room.players[seat] = null;
  // Reassign host if needed
  if (room.hostSeat === seat) {
    const newHost = room.players.findIndex(p => p);
    room.hostSeat = newHost >= 0 ? newHost : null;
  }
  broadcastState(room);
  // If everyone gone, clean up.
  setTimeout(() => deleteIfEmpty(room), 1000);
}

/* Heartbeat to clean dead sockets */
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { try { ws.terminate(); } catch (_) {} return; }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  });
}, 30000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[quiz] listening on http://0.0.0.0:${PORT}`);
  console.log(`[quiz] question bank size: ${QUESTION_BANK.length}`);
});
