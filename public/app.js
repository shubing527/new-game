/* Electrolyte Quiz Show — client.
   Communicates with /ws via JSON messages. No localStorage / cookies. */

(function () {
  'use strict';

  // ---------------- DOM ----------------
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const screenStart = $('#screen-start');
  const screenStage = $('#screen-stage');
  const inputRoom = $('#input-room');
  const inputName = $('#input-name');
  const joinForm = $('#join-form');
  const joinError = $('#join-error');
  const lblRoom = $('#lbl-room');
  const lblQIndex = $('#lbl-qindex');
  const lblQTotal = $('#lbl-qtotal');
  const phasePill = $('#phase-pill');
  const timerEl = $('#timer');
  const podiumsEl = $('#podiums');
  const bbCategory = $('#bb-category');
  const bbScenario = $('#bb-scenario');
  const bbQuestion = $('#bb-question');
  const bbOptions = $('#bb-options');
  const lobbyPanel = $('#lobby-panel');
  const lpCode = $('#lp-code');
  const lpHint = $('#lp-hint');
  const btnStart = $('#btn-start');
  const btnLeave = $('#btn-leave');
  const btnRestart = $('#btn-restart');
  const revealBanner = $('#reveal-banner');
  const finalScreen = $('#final-screen');
  const finalPodium = $('#final-podium');
  const answerBar = $('#answer-bar');
  const ansButtons = $$('.ans');
  const connStatus = $('#conn-status');
  const confettiCanvas = $('#confetti');

  // ---------------- State ----------------
  let ws = null;
  let me = null; // { seat, name, isHost }
  let roomState = null;
  let currentQuestion = null;
  let questionDeadline = 0;
  let timerInterval = null;
  let revealTimeout = null;
  let reconnectAttempts = 0;
  let confettiAnim = null;
  let myChoice = null; // local: chosen index for current question
  let myResult = null; // local: { correct, correctIndex } once server replies

  // Lightweight perf flag: reduce motion on small screens and when user requests it.
  const LOW_MOTION = (() => {
    try {
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return true;
    } catch (_) {}
    return Math.min(window.innerWidth || 1024, window.innerHeight || 768) <= 768;
  })();
  if (LOW_MOTION) document.documentElement.classList.add('low-motion');

  // ---------------- WebSocket ----------------
  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const portProxyBase = '__PORT_5000__';

    // When deployed by Perplexity, __PORT_5000__ is rewritten to the
    // backend proxy base. Locally it remains unchanged, so we fall back to
    // the same-origin /ws endpoint served by node server.js.
    if (!portProxyBase.startsWith('__PORT_')) {
      const proxyUrl = new URL(portProxyBase, location.href);
      proxyUrl.protocol = proto;
      proxyUrl.pathname = `${proxyUrl.pathname.replace(/\/$/, '')}/ws`;
      proxyUrl.search = '';
      proxyUrl.hash = '';
      return proxyUrl.toString();
    }

    return `${proto}//${location.host}/ws`;
  }

  function connect() {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return ws;
    setConn('連線中…', '');
    ws = new WebSocket(wsUrl());
    ws.addEventListener('open', () => {
      reconnectAttempts = 0;
      setConn('已連線', 'ok');
    });
    ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      handleServer(msg);
    });
    ws.addEventListener('close', () => {
      setConn('離線', 'bad');
    });
    ws.addEventListener('error', () => {
      setConn('連線錯誤', 'bad');
    });
    return ws;
  }

  function send(msg) {
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify(msg));
  }

  function setConn(text, cls) {
    connStatus.textContent = text;
    connStatus.classList.remove('ok', 'bad');
    if (cls) connStatus.classList.add(cls);
  }

  // ---------------- Server message routing ----------------
  function handleServer(msg) {
    switch (msg.type) {
      case 'joined': onJoined(msg); break;
      case 'state': onState(msg.room); break;
      case 'question': onQuestion(msg); break;
      case 'answered': onAnswered(msg.seat); break;
      case 'result': onResult(msg); break;
      case 'reveal': onReveal(msg); break;
      case 'final': onFinal(msg); break;
      case 'error': onError(msg); break;
    }
  }

  function onError(msg) {
    if (!me) {
      joinError.textContent = msg.message || '加入失敗';
    } else {
      // Show transient banner
      flashBanner(msg.message || '錯誤', 'bad');
    }
  }

  function onJoined(msg) {
    me = msg.you;
    roomState = msg.room;
    showScreen('stage');
    lblRoom.textContent = roomState.code;
    lpCode.textContent = roomState.code;
    renderRoom();
    updateLobbyControls();
  }

  function onState(room) {
    roomState = room;
    lblRoom.textContent = room.code;
    lpCode.textContent = room.code;
    if (room.totalQuestions) lblQTotal.textContent = room.totalQuestions;
    if (room.phase === 'lobby') {
      showLobby(true);
      hideFinal();
      bbCategory.textContent = '準備好了嗎？';
      bbScenario.textContent = `房主按「開始遊戲」即可開始。已加入 ${room.players.filter(Boolean).length}/3 位選手。`;
      bbQuestion.textContent = me && me.isHost ? '你是房主，可以隨時開始。' : '正在等待房主開始…';
      bbOptions.innerHTML = '';
      timerEl.textContent = '--';
      ansButtons.forEach(b => { b.disabled = true; b.classList.remove('is-locked','is-correct','is-wrong'); b.querySelector('.ans-text').textContent = '—'; });
      phasePill.textContent = '大廳';
    } else {
      showLobby(false);
    }
    if (room.phase === 'reveal') phasePill.textContent = '解析中';
    if (room.phase === 'question') phasePill.textContent = '搶答中';
    if (room.phase === 'final') phasePill.textContent = '結算';

    renderRoom();
    updateLobbyControls();
  }

  function onQuestion(q) {
    currentQuestion = q;
    questionDeadline = q.deadlineTs;
    myChoice = null;
    myResult = null;
    hideFinal();
    showLobby(false);
    bbCategory.textContent = q.category || '電解質知識';
    bbScenario.textContent = q.scenario || '';
    bbQuestion.textContent = q.question || '';
    lblQIndex.textContent = (q.index + 1);
    lblQTotal.textContent = q.total;
    // Render options
    bbOptions.innerHTML = '';
    const letters = ['A','B','C','D'];
    q.options.forEach((opt, i) => {
      const li = document.createElement('li');
      li.dataset.idx = String(i);
      li.innerHTML = `<span class="opt-letter">${letters[i]}</span><span>${escapeHtml(opt)}</span>`;
      bbOptions.appendChild(li);
    });
    // Buzzers
    ansButtons.forEach((b, i) => {
      const text = q.options[i] || '';
      b.querySelector('.ans-text').textContent = text;
      b.classList.remove('is-locked','is-correct','is-wrong');
      b.disabled = false;
    });
    startTimer();
    flashBanner(`第 ${q.index + 1} 題`, 'good', 1100);
  }

  function onAnswered(seat) {
    // Neutral "已作答" label — does NOT imply correctness for anyone.
    const pod = podiumsEl.querySelector(`[data-seat="${seat}"]`);
    if (pod) {
      const state = pod.querySelector('.pod-state');
      state.textContent = '已作答';
      state.classList.remove('correct','wrong');
      state.classList.add('locked','show');
    }
  }

  function onResult(msg) {
    // Server's authoritative judgment for THIS player only.
    myResult = { correct: !!msg.correct, correctIndex: msg.correctIndex };
    // Disable buzzers (already disabled locally on click, reinforce here)
    ansButtons.forEach(b => { b.disabled = true; });
    // Mark the player's chosen buzzer correct/wrong immediately.
    if (myChoice != null) {
      const btn = ansButtons[myChoice];
      if (btn) {
        btn.classList.remove('is-locked');
        btn.classList.add(msg.correct ? 'is-correct' : 'is-wrong');
      }
    }
    // Update own podium label to personal result.
    if (me) {
      const pod = podiumsEl.querySelector(`[data-seat="${me.seat}"]`);
      if (pod) {
        const state = pod.querySelector('.pod-state');
        state.classList.remove('locked');
        if (msg.correct) {
          state.textContent = '答對';
          state.classList.remove('wrong');
          state.classList.add('correct','show');
        } else {
          state.textContent = '答錯';
          state.classList.remove('correct');
          state.classList.add('wrong','show');
        }
      }
    }
    flashBanner(msg.correct ? '答對了！等待其他人…' : '答錯了，等待結算…', msg.correct ? 'good' : 'bad', 1800);
  }

  function onReveal(msg) {
    stopTimer();
    timerEl.textContent = '--';
    // Annotate options on blackboard
    Array.from(bbOptions.children).forEach((li, i) => {
      if (i === msg.correct) li.classList.add('is-correct');
      else li.classList.add('is-wrong');
    });
    // Update buzzer states for self — clear any pending state first.
    if (me) {
      const myInfo = msg.perPlayer.find(p => p.seat === me.seat);
      ansButtons.forEach((b, i) => {
        b.disabled = true;
        b.classList.remove('is-pending','is-locked');
        if (i === msg.correct) b.classList.add('is-correct');
        if (myInfo && myInfo.choice === i && !myInfo.correct) {
          b.classList.remove('is-correct');
          b.classList.add('is-wrong');
        }
      });
    }
    // Update pod-state per player
    msg.perPlayer.forEach(pp => {
      const pod = podiumsEl.querySelector(`[data-seat="${pp.seat}"]`);
      if (!pod) return;
      const state = pod.querySelector('.pod-state');
      state.classList.remove('locked');
      if (pp.choice === null) {
        state.textContent = '未作答';
        state.classList.add('wrong','show');
      } else if (pp.correct) {
        state.textContent = '+5 分';
        state.classList.remove('wrong');
        state.classList.add('correct','show');
      } else {
        state.textContent = '答錯';
        state.classList.remove('correct');
        state.classList.add('wrong','show');
      }
    });
    // Bump scores
    msg.scores.forEach((s, i) => {
      if (s == null) return;
      const pod = podiumsEl.querySelector(`[data-seat="${i}"]`);
      if (!pod) return;
      const scoreEl = pod.querySelector('.pod-score');
      const oldVal = parseInt(scoreEl.textContent, 10) || 0;
      if (s !== oldVal) {
        scoreEl.textContent = String(s);
        scoreEl.classList.add('bump');
        setTimeout(() => scoreEl.classList.remove('bump'), 240);
      }
    });
    // Banner
    if (me) {
      const myInfo = msg.perPlayer.find(p => p.seat === me.seat);
      if (!myInfo || myInfo.choice === null) {
        flashBanner('沒作答', 'bad', 2400);
      } else if (myInfo.correct) {
        flashBanner('答對了！+5 分', 'good', 2400);
      } else {
        flashBanner('答錯了，下一題加油', 'bad', 2400);
      }
    }
    // Show explanation in place of question
    setTimeout(() => {
      if (currentQuestion) {
        const exp = (msg.explanation || '').trim();
        if (exp) {
          bbQuestion.innerHTML = `<span style="color:var(--warm-gold);font-size:14px;font-weight:800;letter-spacing:.1em;">解析</span><br/>${escapeHtml(exp)}`;
        }
      }
    }, 600);
  }

  function onFinal(msg) {
    stopTimer();
    timerEl.textContent = '--';
    finalPodium.innerHTML = '';
    // build positions: 2nd / 1st / 3rd visual order
    const byRank = {};
    msg.ranking.forEach(r => { (byRank[r.rank] = byRank[r.rank] || []).push(r); });
    const slots = [byRank[2] || [], byRank[1] || [], byRank[3] || []];
    const cls = ['rank2','rank1','rank3'];
    slots.forEach((items, idx) => {
      if (!items.length) return;
      items.forEach(item => {
        const li = document.createElement('li');
        li.className = cls[idx];
        li.innerHTML = `
          <div class="fp-rank">${item.rank}</div>
          <div class="fp-name">${escapeHtml(item.name)}</div>
          <div class="fp-score">${item.score}</div>
        `;
        finalPodium.appendChild(li);
      });
    });
    finalScreen.classList.add('show');
    startConfetti();
    // restart only visible to host
    btnRestart.style.display = me && me.isHost ? '' : 'none';
  }

  function hideFinal() {
    finalScreen.classList.remove('show');
    stopConfetti();
  }

  // ---------------- Render helpers ----------------
  function showScreen(name) {
    screenStart.classList.toggle('show', name === 'start');
    screenStage.classList.toggle('show', name === 'stage');
  }

  function showLobby(show) {
    lobbyPanel.classList.toggle('show', show);
  }

  function updateLobbyControls() {
    if (!roomState || !me) return;
    const playerCount = roomState.players.filter(Boolean).length;
    if (me.isHost) {
      btnStart.disabled = playerCount < 1;
      lpHint.textContent = playerCount < 1 ? '至少要有一位玩家才能開始' : `已就緒，按下開始遊戲（${playerCount}/3）`;
    } else {
      btnStart.disabled = true;
      lpHint.textContent = '正在等待房主開始遊戲…';
    }
  }

  function renderRoom() {
    if (!roomState) return;
    podiumsEl.innerHTML = '';
    for (let i = 0; i < 3; i++) {
      const p = roomState.players[i];
      const pod = document.createElement('div');
      pod.className = 'podium' + (p ? '' : ' empty') + (me && me.seat === i ? ' is-self' : '');
      pod.dataset.seat = String(i);
      pod.setAttribute('role', 'listitem');
      pod.innerHTML = `
        <div class="pod-state"></div>
        <div class="contestant ${p ? '' : 'empty'}">${contestantSVG(i, !!p)}</div>
        <div class="pod-box">
          <div class="pod-front">
            <div class="pod-score" data-testid="text-score-${i}">${p ? p.score : 0}</div>
            <div class="pod-name" data-testid="text-name-${i}">${p ? escapeHtml(p.name) : '等待玩家'}</div>
          </div>
        </div>
        <div class="pod-number">${i+1}</div>
        ${p && p.isHost ? '<div class="pod-badge">房主</div>' : ''}
      `;
      podiumsEl.appendChild(pod);
      if (p) pod.classList.add('appearing');
    }
  }

  function contestantSVG(seat, present) {
    const palettes = [
      { skin: '#f1c8a6', hair: '#2a2017', shirt: '#3b6dd6', accent: '#234aa6' }, // blue glasses guy
      { skin: '#f1c8a6', hair: '#a83a2a', shirt: '#c93a3a', accent: '#8a2222' }, // red sweater
      { skin: '#f1c8a6', hair: '#3a2c1f', shirt: '#f4f7fb', accent: '#9aa3b4' }, // white shirt
    ];
    const c = palettes[seat % 3];
    if (!present) {
      // Silhouette only
      return `<svg viewBox="0 0 120 120" class="contestant-shape" aria-hidden="true">
        <circle cx="60" cy="40" r="20" fill="rgba(255,255,255,0.18)"/>
        <path d="M28 110 Q28 72 60 72 Q92 72 92 110 Z" fill="rgba(255,255,255,0.18)"/>
      </svg>`;
    }
    return `<svg viewBox="0 0 120 120" aria-hidden="true">
      <!-- body -->
      <path d="M22 120 Q22 78 60 78 Q98 78 98 120 Z" fill="${c.shirt}"/>
      <path d="M40 88 Q60 100 80 88 L80 120 L40 120 Z" fill="${c.accent}" opacity="0.4"/>
      <!-- collar -->
      <path d="M52 78 L60 88 L68 78 Z" fill="${c.skin}"/>
      <!-- head -->
      <circle cx="60" cy="44" r="22" fill="${c.skin}"/>
      <!-- hair (varies by seat) -->
      ${seat === 0 ? `
        <path d="M38 44 Q40 22 60 22 Q80 22 82 44 Q78 36 60 36 Q42 36 38 44 Z" fill="${c.hair}"/>
        <rect x="46" y="42" width="12" height="9" rx="2" fill="none" stroke="#222" stroke-width="2"/>
        <rect x="62" y="42" width="12" height="9" rx="2" fill="none" stroke="#222" stroke-width="2"/>
        <line x1="58" y1="46" x2="62" y2="46" stroke="#222" stroke-width="2"/>
      ` : ''}
      ${seat === 1 ? `
        <path d="M38 42 Q42 18 60 20 Q82 22 82 46 Q78 32 60 32 Q42 32 38 42 Z" fill="${c.hair}"/>
        <path d="M50 56 Q60 64 70 56 L70 60 Q60 66 50 60 Z" fill="${c.hair}"/>
        <circle cx="52" cy="46" r="2" fill="#1a1a1a"/>
        <circle cx="68" cy="46" r="2" fill="#1a1a1a"/>
      ` : ''}
      ${seat === 2 ? `
        <path d="M40 40 Q44 22 60 22 Q80 22 82 44 Q74 32 60 32 Q46 32 40 40 Z" fill="${c.hair}"/>
        <circle cx="52" cy="48" r="2" fill="#1a1a1a"/>
        <circle cx="68" cy="48" r="2" fill="#1a1a1a"/>
      ` : ''}
      <!-- mouth -->
      <path d="M54 58 Q60 62 66 58" stroke="#7a3b2a" stroke-width="2" fill="none" stroke-linecap="round"/>
      <!-- arm raised slightly -->
      <path d="M88 92 L102 70" stroke="${c.shirt}" stroke-width="10" stroke-linecap="round"/>
      <circle cx="103" cy="68" r="6" fill="${c.skin}"/>
    </svg>`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[ch]));
  }

  // ---------------- Timer ----------------
  function startTimer() {
    stopTimer();
    function tick() {
      const ms = Math.max(0, questionDeadline - Date.now());
      const sec = Math.ceil(ms / 1000);
      timerEl.textContent = String(sec);
      timerEl.classList.toggle('urgent', sec <= 5);
      if (ms <= 0) stopTimer();
    }
    tick();
    timerInterval = setInterval(tick, 200);
  }
  function stopTimer() {
    if (timerInterval) clearInterval(timerInterval); timerInterval = null;
    timerEl.classList.remove('urgent');
  }

  // ---------------- Banner ----------------
  function flashBanner(text, kind, ms = 1400) {
    revealBanner.textContent = text;
    revealBanner.classList.remove('good','bad');
    if (kind) revealBanner.classList.add(kind);
    revealBanner.classList.add('show');
    clearTimeout(revealBanner._t);
    revealBanner._t = setTimeout(() => revealBanner.classList.remove('show'), ms);
  }

  // ---------------- Confetti ----------------
  function startConfetti() {
    const ctx = confettiCanvas.getContext('2d');
    function resize() { confettiCanvas.width = innerWidth; confettiCanvas.height = innerHeight; }
    resize(); window.addEventListener('resize', resize);
    const colors = ['#f5c947','#5dd483','#6cb7e9','#f08a3c','#e15a4f','#ffffff'];
    const N = LOW_MOTION ? 50 : 140;
    const parts = [];
    for (let i = 0; i < N; i++) {
      parts.push({
        x: Math.random() * confettiCanvas.width,
        y: -20 - Math.random() * confettiCanvas.height,
        vx: (Math.random() - 0.5) * 2,
        vy: 2 + Math.random() * 3,
        s: 4 + Math.random() * 6,
        r: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.2,
        c: colors[i % colors.length],
      });
    }
    let alive = true;
    function frame() {
      if (!alive) return;
      ctx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
      parts.forEach(p => {
        p.x += p.vx; p.y += p.vy; p.r += p.vr;
        if (p.y > confettiCanvas.height + 20) { p.y = -20; p.x = Math.random() * confettiCanvas.width; }
        ctx.save();
        ctx.translate(p.x, p.y); ctx.rotate(p.r);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.s/2, -p.s/2, p.s, p.s * 0.6);
        ctx.restore();
      });
      confettiAnim = requestAnimationFrame(frame);
    }
    confettiAnim = requestAnimationFrame(frame);
    confettiAnim._stop = () => { alive = false; cancelAnimationFrame(confettiAnim); };
  }
  function stopConfetti() {
    if (confettiAnim && confettiAnim._stop) confettiAnim._stop();
    const ctx = confettiCanvas.getContext('2d');
    ctx && ctx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
    confettiAnim = null;
  }

  // ---------------- Events ----------------
  joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    joinError.textContent = '';
    const room = inputRoom.value.trim().toUpperCase();
    const name = inputName.value.trim();
    if (!room) { joinError.textContent = '請輸入房間密碼'; return; }
    connect();
    const tryJoin = () => send({ type: 'join', room, name });
    if (ws.readyState === 1) tryJoin();
    else ws.addEventListener('open', tryJoin, { once: true });
    ws.addEventListener('error', () => {
      if (!me) joinError.textContent = '連線失敗，請重新整理後再試。';
    }, { once: true });
  });

  ansButtons.forEach((b) => {
    b.addEventListener('click', () => {
      if (b.disabled) return;
      const letter = b.dataset.letter;
      const choice = ['A','B','C','D'].indexOf(letter);
      if (choice < 0) return;
      // Lock locally immediately. Neutral pending visual — we don't know yet
      // if it's correct; the server reply (type 'result') decides.
      ansButtons.forEach(o => o.disabled = true);
      b.classList.add('is-pending');
      myChoice = choice;
      send({ type: 'answer', choice });
    });
  });

  btnStart.addEventListener('click', () => send({ type: 'start' }));
  btnRestart.addEventListener('click', () => {
    hideFinal();
    send({ type: 'restart' });
  });
  btnLeave.addEventListener('click', () => {
    if (ws) ws.close();
    me = null; roomState = null;
    showScreen('start');
  });

  // Auto-uppercase room input
  inputRoom.addEventListener('input', () => {
    const v = inputRoom.value.toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    if (v !== inputRoom.value) inputRoom.value = v;
  });

  // Test helpers exposed for QA — not user-facing.
  window.__quizTest = {
    state: () => roomState,
    me: () => me,
    pickAnswer: (letter) => {
      const b = document.querySelector(`.ans[data-letter="${letter}"]`);
      if (b && !b.disabled) b.click();
    },
    join: (room, name) => {
      inputRoom.value = room || 'TEST';
      inputName.value = name || '';
      joinForm.requestSubmit();
    },
    start: () => btnStart.click(),
  };
})();
