# Multiplayer Electrolyte Quiz — Handoff

## Project
- **Path:** `/home/user/workspace/multiplayer-electrolyte-quiz`
- **Stack:** Node.js + Express + `ws` (WebSocket) + vanilla HTML/CSS/JS
- **Build needed?** No build step. Plain Node app. Just `npm install` then `node server.js`.
- **Server start command:** `node server.js`
- **Port:** 5000 (configurable via `PORT` env var)
- **WebSocket path:** `/ws`
- **HTTP health check:** `GET /health` → `{ok:true, rooms:n}`

## Files
```
multiplayer-electrolyte-quiz/
├── package.json              # express + ws
├── server.js                 # rooms, WS protocol, game state machine
├── questions.js              # CommonJS wrapper that evals questions-source
├── questions-source.js       # 50-question bank copied from electrolyte-snake
├── public/
│   ├── index.html            # start screen + stage screen markup
│   ├── style.css             # cartoon quiz-show stage styling
│   └── app.js                # WS client, render, animations
├── HANDOFF.md
└── qa-*.jpg                  # screenshots from QA run
```

## How it works (brief)
- User opens `/`, types a room password (auto-uppercased), optional display name.
- Client connects to `/ws`, sends `{type:'join', room, name}`.
- Server creates room if missing; max 3 seats. First joiner becomes host.
- Host taps **開始遊戲**. Server picks 20 random questions from the 50-question bank (configurable via `QUESTIONS_PER_MATCH`).
- Per question (20 s default, `QUESTION_DURATION_MS`): all clients see scenario + 4 options on the blackboard. Each presses A/B/C/D. Choice is locked client-side and on the server. Question resolves when all active players answer or timer expires.
- Reveal phase (~6 s, `REVEAL_DURATION_MS`): correct option highlighted, explanation shown, scores increment with bump animation, banner shows correct/wrong. Auto-advances.
- After 20 questions: final overlay with confetti and 1st/2nd/3rd podium (ties supported via dense rank). Host can press **再來一場** to return to lobby.
- All state is in-memory; rooms are removed when last socket disconnects. Server restart clears all rooms.

## Multiplayer protocol
WebSocket JSON. See header comment in `server.js`:
- C→S: `join`, `start`, `answer`, `next`, `restart`, `ping`
- S→C: `joined`, `state`, `question`, `answered`, `reveal`, `final`, `error`, `pong`
- Late join during a match returns `error: inprogress`. 4th joiner returns `error: full` ("房間已滿（最多 3 人）").

## QA results (Playwright, two browser contexts)
- ✅ Two separate browser contexts join room `ION88`; both see each other's seat/name.
- ✅ Case-insensitive room codes (`ion88` → `ION88`).
- ✅ Empty name auto-fills to `玩家 N`.
- ✅ Host sees enabled **開始遊戲**; non-host sees disabled with hint「正在等待房主開始遊戲…」.
- ✅ Pressing start broadcasts question to both clients; question text, scenario, options match.
- ✅ Both clients can lock answers; UI marks podium as「已作答」, locks all 4 buttons.
- ✅ Resolves early when both answer; reveal shows correct option green, wrong choices struck-through; +5 scores update with bump animation; per-player state pill shows「+5 分」or「答錯」.
- ✅ Auto-advance to next question; counter increments.
- ✅ End of match (tested with `QUESTIONS_PER_MATCH=4 REVEAL_DURATION_MS=2000`): final podium overlay renders with confetti, 1st 小華 (20 pts) on tallest pedestal, 2nd 玩家二 (0 pts) on shorter one. Restart returns room to lobby with cleared scores.
- ✅ 3rd player (Carol) joins same room — all 3 contestants render with distinct cartoon styles (glasses, red sweater, white shirt) like the reference image.
- ✅ 4th player gets「房間已滿（最多 3 人）」 error and stays on start screen.
- ✅ No `localStorage` / `sessionStorage` / `indexedDB` / `document.cookie` usage anywhere (`grep` clean — only one comment match).
- ✅ Mobile viewport (390×844) start screen renders cleanly.

## Visual elements (matches reference)
- Cartoon teal-blue stage with curtain, animated spotlights, pink stage floor
- Host SVG figure on the left with clipboard, suit, beard, pointing arm
- Three contestant podiums with distinct cartoon characters and seat numbers
- Wood-frame blackboard with bulb lights showing scenario, question, and 4 options
- Score boxes in dark navy with gold digits, name plate, "1/2/3" seat number badge
- Bottom buzzer bar with 4 colour-coded answer buttons (yellow/green/blue/orange)
- Custom inline SVG logo (lightning bolt + circle on gold square)
- Confetti animation on final podium reveal
- All UI text in Traditional Chinese (台灣用語)

## Known limitations / behaviour
- Late-join during a game is **rejected** (simpler and robust). Spectator mode is not implemented.
- Disconnected players free their seat; if the host disconnects, the next active seat becomes host. Score for a disconnected player is preserved on the seat for the rest of the match unless another player re-enters that seat — but since rejoin during 'question'/'reveal' is blocked, in practice the seat stays empty.
- No persistence — rooms vanish on server restart. UI handles it gracefully (a closed socket flips the connection pill to 「離線」).
- Test helpers exposed at `window.__quizTest` (`state()`, `me()`, `pickAnswer('A')`, `join(code, name)`, `start()`).
- For faster smoke tests use env vars: `QUESTIONS_PER_MATCH=4 REVEAL_DURATION_MS=2000 QUESTION_DURATION_MS=10000 node server.js`.

## Next steps for parent agent
1. Start prod server: `start_server(command="node server.js", project_path="/home/user/workspace/multiplayer-electrolyte-quiz", port=5000)`.
2. Deploy: `deploy_website(project_path="/home/user/workspace/multiplayer-electrolyte-quiz/public", site_name="電解質益智擂台", entry_point="index.html")`.
   - The deployment proxy must forward WebSocket `/ws` requests to backend port 5000 for multiplayer to work.
