const http = require("http");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");

const app = express();
const BASE = (process.env.BASE_PATH || "").replace(/\/$/, "");
if (BASE) app.use((req, res, next) => { if (req.path === BASE) return res.redirect(301, BASE + "/"); next(); });
app.use(BASE || "/", express.static(path.join(__dirname, "public")));
const server = http.createServer(app);
const io = new Server(server, { path: BASE + "/socket.io", cors: { origin: true } });

const PORT = process.env.PORT || 3000;
const MIN_PLAYERS = 4;
const MAX_PLAYERS = 12;
const CLUE_MS = Number(process.env.CLUE_MS || 90000);
const GUESS_MS = Number(process.env.GUESS_MS || 75000);
const AFK_MS = Math.max(200, Number(process.env.AFK_MS || 5000));   // T1: the phase ends this soon once everyone who could act is disconnected
const TIMEOUTS_TO_BOT = 3;                                              // consecutive missed phases before the seat is skipped automatically

const WORDS = ("ocean,river,mountain,forest,desert,island,volcano,glacier,canyon,beach,storm,thunder,rainbow,shadow,mirror,candle,lantern,bridge,castle,tower,tunnel,harbor,anchor,compass,map,treasure,pirate,ninja,knight,dragon,giant,witch,ghost,robot,alien,rocket,planet,comet,star,moon,sun,cloud,wind,fire,ice,stone,crystal,diamond,gold,silver,copper,iron,steel,glass,paper,scissors,hammer,needle,thread,button,pocket,jacket,boot,glove,crown,ring,chain,key,lock,door,window,ladder,rope,net,trap,cage,nest,egg,feather,wing,claw,tail,horn,shell,spider,scorpion,snake,eagle,falcon,owl,raven,wolf,fox,bear,tiger,lion,panther,shark,whale,dolphin,octopus,crab,turtle,frog,rabbit,mouse,horse,camel,elephant,monkey,panda,koala,penguin,seal,batman,circus,clown,magician,juggler,acrobat,parade,carnival,festival,concert,orchestra,violin,piano,trumpet,drum,flute,guitar,opera,ballet,statue,museum,gallery,library,school,hospital,market,bakery,butcher,farmer,doctor,nurse,pilot,sailor,soldier,spy,detective,judge,lawyer,teacher,student,chef,waiter,barber,tailor,king,queen,prince,princess,wizard,angel,devil,giant,dwarf,elf,troll,zombie,vampire,mummy,skeleton,pyramid,sphinx,temple,church,mosque,palace,fortress,dungeon,maze,garden,fountain,well,mill,barn,fence,gate,path,road,highway,train,subway,tram,bus,taxi,truck,tractor,bicycle,scooter,ship,boat,canoe,ferry,submarine,helicopter,parachute,balloon,kite,arrow,bow,sword,shield,armor,helmet,cannon,bomb,torch,flag,banner,trophy,medal,ticket,coin,wallet,basket,bottle,barrel,bucket,kettle,teapot,plate,spoon,fork,knife,pan,oven,fridge,ladder,broom,brush,soap,towel,pillow,blanket,carpet,curtain,clock,calendar,letter,stamp,pencil,eraser,notebook,camera,radio,telephone,battery,magnet,engine,wheel,spring,screw,pipe,wire,cable,satellite,antenna,laser,microscope,telescope").split(",").map(w=>w.trim()).filter(Boolean).filter((w,i,a)=>a.indexOf(w)===i);

const rooms = new Map();
const roomSockets = new Map();
const timers = new Map();

const newId = () => crypto.randomBytes(8).toString("hex");
const newCode = () => {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let c = "";
  for (let i = 0; i < 6; i++) c += A[crypto.randomInt(A.length)];
  return rooms.has(c) ? newCode() : c;
};
const clean = (s, n) => String(s || "").replace(/[<>]/g, "").trim().slice(0, n);

function clearT(code) { const t = timers.get(code); if (t) { clearTimeout(t); timers.delete(code); } }
function deleteRoom(code) { clearT(code); rooms.delete(code); roomSockets.delete(code); }
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function setupGame(room) {
  const seats = room.players.map((p, i) => (!p.left ? i : -1)).filter((i) => i >= 0);
  shuffle(seats);
  room.teamOf = {};
  seats.forEach((s, k) => { room.teamOf[s] = k % 2 === 0 ? "A" : "B"; });
  const teamA = seats.filter((s) => room.teamOf[s] === "A");
  const teamB = seats.filter((s) => room.teamOf[s] === "B");
  room.spymaster = { A: teamA[0], B: teamB[0] };
  // board
  const pool = shuffle(WORDS.slice());
  room.words = pool.slice(0, 25);
  room.startTeam = crypto.randomInt(2) === 0 ? "A" : "B";
  const other = room.startTeam === "A" ? "B" : "A";
  const key = [];
  for (let i = 0; i < 9; i++) key.push(room.startTeam);
  for (let i = 0; i < 8; i++) key.push(other);
  for (let i = 0; i < 7; i++) key.push("N");
  key.push("X");
  room.key = shuffle(key);
  room.revealed = new Array(25).fill(null);
  room.turnTeam = room.startTeam;
  room.phase = "clue";
  room.clue = null;
  room.guessesLeft = 0;
  room.guessedThisTurn = 0;
  room.winner = null;
  room.winReason = null;
  room.status = "playing";
  room.log = `Teams drawn. ${room.startTeam === "A" ? "Red" : "Blue"} team starts with 9 words. Spymaster, give a clue.`;
  armTimer(room);
}

function remain(room, t) {
  let n = 0;
  for (let i = 0; i < 25; i++) if (room.key[i] === t && !room.revealed[i]) n++;
  return n;
}

function endGame(room, winner, reason, msg) {
  room.winner = winner;
  room.winReason = reason;
  room.status = "over";
  room.phase = "over";
  room.log = msg;
  clearT(room.code);
}

function flipTurn(room, msg) {
  room.turnTeam = room.turnTeam === "A" ? "B" : "A";
  room.phase = "clue";
  room.clue = null;
  room.guessesLeft = 0;
  room.guessedThisTurn = 0;
  room.actedThisTurn = new Set();
  if (msg) room.log = msg;
  armTimer(room);
}

/* T1 AFK policy. There is no bot heuristic in Word Spies: a skipped seat is simply not waited for.
   "Pending" = the players who could still act in this phase and are not bot-controlled. */
function pendingActors(room) {
  if (room.status !== "playing") return [];
  const t = room.turnTeam;
  if (room.phase === "clue") { const sp = room.players[room.spymaster[t]]; return sp && !sp.left && !sp.botControlled ? [sp] : []; }
  if (room.phase === "guess") return room.players.filter((p, s) => !p.left && room.teamOf[s] === t && room.spymaster[t] !== s && !p.botControlled);
  return [];
}
function guessersOf(room, t) { return room.players.map((p, s) => (!p.left && room.teamOf[s] === t && room.spymaster[t] !== s ? s : -1)).filter((s) => s >= 0); }
/* Nobody left to act for the turn team. Mirrors the leave rule: a team that cannot play forfeits.
   If only the map is unmanned but a guesser is available, hand the map over instead. */
function skipIfNobody(room) {
  if (room.status !== "playing" || pendingActors(room).length) return false;
  const t = room.turnTeam, o = t === "A" ? "B" : "A";
  const avail = (team) => room.players.map((p, s) => (!p.left && !p.botControlled && room.teamOf[s] === team ? s : -1)).filter((s) => s >= 0);
  if (!avail(o).length && !avail(t).length) { endGame(room, null, "abandoned", "Nobody is left at the table. Game over."); return true; }
  if (room.phase === "clue") {
    const mate = avail(t).find((s) => room.players[s].connected) ?? avail(t)[0];
    if (mate != null) { room.spymaster[t] = mate; room.log = `${room.players[mate].name} takes over the map for ${tname(t)}.`; return false; }   // pending is non-empty now
  }
  endGame(room, o, "forfeit", `${tname(t)} has nobody left to ${room.phase === "clue" ? "give clues" : "guess"} — ${tname(o)} wins by default.`);
  return true;
}
function refreshAfkClock(room) {
  if (room.status !== "playing") return;
  if (skipIfNobody(room)) return;
  const pend = pendingActors(room);
  if (pend.some((p) => p.connected)) return;
  const soon = Date.now() + AFK_MS;
  if (room.phaseEndsAt && room.phaseEndsAt <= soon) return;
  room.phaseEndsAt = soon;
  clearT(room.code);
  timers.set(room.code, setTimeout(() => onPhaseTimeout(room.code), AFK_MS));
}
function armTimer(room) {
  clearT(room.code);
  if (room.status !== "playing") { room.phaseEndsAt = null; return; }
  room.actedThisTurn = room.actedThisTurn || new Set();
  if (skipIfNobody(room)) return;   // flipTurn re-arms
  const pend = pendingActors(room);
  const base = room.phase === "clue" ? CLUE_MS : GUESS_MS;
  const ms = pend.length && pend.every((p) => !p.connected) ? Math.min(base, AFK_MS) : base;
  room.phaseEndsAt = Date.now() + ms;
  timers.set(room.code, setTimeout(() => onPhaseTimeout(room.code), ms));
}
function onPhaseTimeout(code) {
  const r = rooms.get(code);
  if (!r || r.status !== "playing") return;
  const notes = [];
  const t = r.turnTeam;
  for (const p of pendingActors(r)) {
    const s = r.players.indexOf(p);
    if (r.phase === "guess" && r.actedThisTurn && r.actedThisTurn.has(s)) { p.timeouts = 0; continue; }   // they did tap this turn
    p.timeouts = (p.timeouts || 0) + 1;
    if (p.timeouts >= TIMEOUTS_TO_BOT && !p.botControlled) {
      p.botControlled = true;
      notes.push(`${p.name} is away (missed ${TIMEOUTS_TO_BOT} in a row) — the table no longer waits for them.`);
      if (r.spymaster[t] === s) {   // hand the map to an available teammate so the team can keep playing
        const mate = guessersOf(r, t).find((g) => r.players[g].connected && !r.players[g].botControlled);
        if (mate != null) { r.spymaster[t] = mate; notes.push(`${r.players[mate].name} takes over the map for ${tname(t)}.`); }
      }
    }
  }
  if (r.phase === "clue") flipTurn(r, `Time! ${tname(t)}'s spymaster froze — turn passes.`);
  else flipTurn(r, `Time! ${tname(t)} ran out of guessing time.`);
  if (notes.length) r.log = `${notes.join(" ")} ${r.log || ""}`.trim();
  bump(r);
}
/* The human acts (or reconnects): stop skipping them and reset the streak. */
function humanIsBack(room, p, reason) {
  const wasBot = !!p.botControlled;
  p.timeouts = 0;
  if (!wasBot) return false;
  p.botControlled = false;
  room.log = `${p.name} is back at the table${reason ? " (" + reason + ")" : ""}.`;
  return true;
}

function tname(t) { return t === "A" ? "Red" : "Blue"; }

/* ---------- per-player filtered state: only spymasters see the map ---------- */
function stateFor(room, seat) {
  const over = room.status === "over";
  const isSpy = seat >= 0 && room.spymaster && (room.spymaster.A === seat || room.spymaster.B === seat);
  return {
    code: room.code, status: room.status, phase: room.phase,
    turnTeam: room.turnTeam || null, startTeam: room.startTeam || null,
    clue: room.clue, guessesLeft: room.guessesLeft,
    guessedThisTurn: room.guessedThisTurn || 0,
    log: room.log, winner: room.winner, winReason: room.winReason,
    phaseEndsAt: room.phaseEndsAt || null,
    hostSeat: room.players.findIndex((p) => p.id === room.host),
    minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS,
    players: room.players.map((p, s) => ({
      name: p.name, avatar: p.avatar, left: p.left, connected: p.connected, botControlled: !!p.botControlled,
      team: room.teamOf ? room.teamOf[s] || null : null,
      spymaster: room.spymaster ? (room.spymaster.A === s || room.spymaster.B === s) : false,
    })),
    words: room.words || null,
    revealed: room.revealed || null,
    remainA: room.key ? remain(room, "A") : 0,
    remainB: room.key ? remain(room, "B") : 0,
    key: (isSpy || over) && room.key ? room.key : null,
    yourTeam: seat >= 0 && room.teamOf ? room.teamOf[seat] || null : null,
    youAreSpymaster: isSpy,
    voice: room.voice ? Array.from(room.voice) : [],
    chat: (room.chat || []).slice(-60),
  };
}
function bump(room) { room.v = (room.v || 0) + 1; room.touched = Date.now(); sendState(room.code); }

/* ---------- GameNest push (optional; no-op without PUSH_URL) ----------
   The app registers a device token per socket and reports presence; players who are away or disconnected
   get a push when it becomes their turn / a new phase starts, and when someone writes in chat. */
const PUSH_URL = process.env.PUSH_URL || "";
const PUSH_TITLE = 'Word Spies';
function pushTo(p, body, data, collapse) {
  if (!PUSH_URL || !p || !p.pushToken || p.bot || p.left) return;
  if (!(p.away || !p.connected)) return;
  const now = Date.now(); if (p._lastPush && now - p._lastPush < 4000) return; p._lastPush = now;
  fetch(PUSH_URL + "/notify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: p.pushToken, title: PUSH_TITLE, body, data: data || {}, collapse: collapse || undefined }) }).catch(() => {});
}
function pushTurn(room) {   // called after every state broadcast; only fires when the situation changes
  const key = room.status + "|" + room.turnTeam + "|" + room.phase;
  if (room._pushKey === key) return; room._pushKey = key;
  if (room.status !== "playing") return;
  for (const p of room.players) { if (p.team !== room.turnTeam) continue;
    const text = room.phase === "clue" ? (p.spymaster ? "Your team's turn — give a clue" : null) : room.phase === "guess" ? (p.spymaster ? null : "Clue is in — tap your team's words") : null;
    if (text) pushTo(p, text + " · room " + room.code, { code: room.code, game: PUSH_TITLE }, room.code + "-turn"); }
}

function sendState(code) {
  const room = rooms.get(code);
  const socks = roomSockets.get(code);
  if (!room || !socks) return;
  for (const s of socks) {
    const seat = room.players.findIndex((p) => p.id === s.data.playerId);
    s.emit("state", { room: stateFor(room, seat), mySeat: seat, v: room.v });
    try { pushTurn(room); } catch (_) {}
  }
}

io.on("connection", (socket) => {
  socket.data.playerId = null;
  socket.data.code = null;
  const currentRoom = () => rooms.get(socket.data.code);
  const attach = (code) => {
    socket.data.code = code;
    if (!roomSockets.has(code)) roomSockets.set(code, new Set());
    roomSockets.get(code).add(socket);
  };
  const detach = () => {
    const set = roomSockets.get(socket.data.code);
    if (set) set.delete(socket);
    socket.data.code = null;
  };
  const mySeat = () => {
    const r = currentRoom();
    return r ? r.players.findIndex((p) => p.id === socket.data.playerId) : -1;
  };

  socket.on("create", ({ name, playerId, avatar } = {}) => {
    name = clean(name, 18); if (!name) return socket.emit("err", "Pick a name first.");
    const code = newCode();
    const room = { code, status: "lobby", host: playerId, players: [], chat: [], log: "", v: 1,
      touched: Date.now(), voice: new Set(), phase: "lobby" };
    room.players.push({ id: playerId, name, avatar: clean(avatar, 4) || "\u{1F575}", left: false, connected: true });
    rooms.set(code, room);
    socket.data.playerId = playerId;
    attach(code);
    socket.emit("joined", { code });
    bump(room);
  });

  socket.on("join", ({ code, name, playerId, avatar } = {}) => {
    code = clean(code, 6).toUpperCase();
    const room = rooms.get(code);
    if (!room) return socket.emit("err", "No room with that code.");
    socket.data.playerId = playerId;
    const existing = room.players.find((p) => p.id === playerId);
    if (existing) { existing.connected = true; existing.left = false; humanIsBack(room, existing, "reconnected"); attach(code); socket.emit("joined", { code }); bump(room); return; }
    if (room.status !== "lobby") return socket.emit("err", "That game already started.");
    if (room.players.length >= MAX_PLAYERS) return socket.emit("err", "Room is full (12).");
    name = clean(name, 18); if (!name) return socket.emit("err", "Pick a name first.");
    room.players.push({ id: playerId, name, avatar: clean(avatar, 4) || "\u{1F575}", left: false, connected: true });
    attach(code);
    socket.emit("joined", { code });
    room.log = `${name} joined.`;
    bump(room);
  });

  socket.on("start", () => {
    const room = currentRoom();
    if (!room || room.status !== "lobby" || room.host !== socket.data.playerId) return;
    if (room.players.filter((p) => !p.left).length < MIN_PLAYERS)
      return socket.emit("err", `Word Spies needs at least ${MIN_PLAYERS} humans — two teams, one spymaster each.`);
    setupGame(room);
    bump(room);
  });

  socket.on("clue", ({ word, count } = {}) => {
    const room = currentRoom();
    if (!room || room.status !== "playing" || room.phase !== "clue") return;
    const seat = mySeat();
    if (seat >= 0 && humanIsBack(room, room.players[seat], "took the seat back")) bump(room);
    if (seat < 0 || room.spymaster[room.turnTeam] !== seat) return;
    word = clean(word, 20).toUpperCase();
    if (!/^[A-Z]{2,20}$/.test(word)) return socket.emit("err", "Clue must be a single word, letters only.");
    for (let i = 0; i < 25; i++) {
      if (room.revealed[i]) continue;
      const w = room.words[i].toUpperCase();
      if (w === word || w.includes(word) || word.includes(w))
        return socket.emit("err", "That clue is too close to a word on the board.");
    }
    count = Number(count);
    if (!Number.isInteger(count) || count < 0 || count > 9) return socket.emit("err", "Count must be 0-9.");
    room.clue = { word, count, by: seat };
    room.guessesLeft = count === 0 ? 25 : count + 1;
    room.guessedThisTurn = 0;
    room.phase = "guess";
    room.log = `${tname(room.turnTeam)} clue: ${word} · ${count}. Guessers, talk it out and tap.`;
    armTimer(room);
    bump(room);
  });

  socket.on("tapWord", ({ i } = {}) => {
    const room = currentRoom();
    if (!room || room.status !== "playing" || room.phase !== "guess") return;
    const seat = mySeat();
    if (seat >= 0 && humanIsBack(room, room.players[seat], "took the seat back")) bump(room);
    if (seat < 0 || room.teamOf[seat] !== room.turnTeam) return;
    if (room.spymaster.A === seat || room.spymaster.B === seat) return; // spymasters never tap
    if (!Number.isInteger(i) || i < 0 || i > 24 || room.revealed[i]) return;
    (room.actedThisTurn = room.actedThisTurn || new Set()).add(seat); room.players[seat].timeouts = 0;
    const truth = room.key[i];
    room.revealed[i] = truth;
    room.guessedThisTurn++;
    const team = room.turnTeam;
    const other = team === "A" ? "B" : "A";
    const word = room.words[i];
    if (truth === "X") {
      endGame(room, other, "assassin", `${room.players[seat].name} tapped ${word.toUpperCase()} — the TRAP word! ${tname(other)} wins instantly.`);
      bump(room); return;
    }
    if (remain(room, "A") === 0) { endGame(room, "A", team === "A" ? "solved" : "gifted", `All Red words found — RED WINS!`); bump(room); return; }
    if (remain(room, "B") === 0) { endGame(room, "B", team === "B" ? "solved" : "gifted", `All Blue words found — BLUE WINS!`); bump(room); return; }
    if (truth === team) {
      room.guessesLeft--;
      if (room.guessesLeft <= 0) flipTurn(room, `${word.toUpperCase()} was ${tname(team)}'s — but that's all the guesses. ${tname(other)}'s turn.`);
      else { room.log = `${word.toUpperCase()} is ${tname(team)}'s! Keep going (${room.guessesLeft} left) or pass.`; armTimer(room); }
    } else if (truth === "N") {
      flipTurn(room, `${word.toUpperCase()} was a bystander. ${tname(other)}'s turn.`);
    } else {
      flipTurn(room, `Ouch — ${word.toUpperCase()} belonged to ${tname(other)}! Their turn.`);
    }
    bump(room);
  });

  socket.on("pass", () => {
    const room = currentRoom();
    if (!room || room.status !== "playing" || room.phase !== "guess") return;
    const seat = mySeat();
    if (seat >= 0 && humanIsBack(room, room.players[seat], "took the seat back")) bump(room);
    if (seat < 0 || room.teamOf[seat] !== room.turnTeam) return;
    room.players[seat].timeouts = 0;
    const passer = room.turnTeam;
    flipTurn(room, `${tname(passer)} passed. ${tname(passer === "A" ? "B" : "A")}'s turn.`);
    bump(room);
  });
  socket.on("takeSeat", () => {
    const room = currentRoom(); if (!room) return;
    const seat = mySeat();
    if (seat >= 0 && humanIsBack(room, room.players[seat], "took the seat back")) bump(room);
  });
  socket.on("pushToken", ({ token } = {}) => { const room = currentRoom(); if (!room) return; const p = room.players.find((q) => q.id === socket.data.playerId); if (p && typeof token === "string" && /^[0-9a-f]{32,200}$/i.test(token)) p.pushToken = token; });
  socket.on("presence", ({ away } = {}) => { const room = currentRoom(); if (!room) return; const p = room.players.find((q) => q.id === socket.data.playerId); if (p) p.away = !!away; });


  socket.on("chat", ({ t } = {}) => {
    const room = currentRoom();
    if (!room) return;
    const seat = mySeat();
    const me = room.players[seat];
    if (!me || me.left) return;
    const now = Date.now();
    if (me._lastChat && now - me._lastChat < 700) return;
    me._lastChat = now;
    t = clean(t, 140); if (!t) return;
    room.chat.push({ n: me.name, a: me.avatar, t }); for (const q of room.players) if (q !== me) pushTo(q, me.name + ": " + t, { code: room.code, game: PUSH_TITLE }, room.code + "-chat");
    if (room.chat.length > 200) room.chat.splice(0, room.chat.length - 200);
    bump(room);
  });

  socket.on("voice", ({ kind, to, data } = {}) => {
    const room = currentRoom();
    if (!room) return;
    const seat = mySeat();
    if (seat < 0) return;
    if (kind === "join" || kind === "leave") {
      if (!room.voice) room.voice = new Set();
      if (kind === "join") room.voice.add(seat); else room.voice.delete(seat);
      bump(room);
      return;
    }
    if (kind === "signal" && Number.isInteger(to) && data) {
      let size = 0; try { size = JSON.stringify(data).length; } catch (e) { return; }
      if (size > 20000) return;
      const socks = roomSockets.get(room.code);
      if (!socks) return;
      for (const s of socks) {
        const sSeat = room.players.findIndex((p) => p.id === s.data.playerId);
        if (sSeat === to) s.emit("voice", { kind: "signal", from: seat, data });
      }
    }
  });

  socket.on("rematch", () => {
    const room = currentRoom();
    if (!room || room.status !== "over" || room.host !== socket.data.playerId) return;
    room.players = room.players.filter((p) => !p.left);
    if (room.players.length < MIN_PLAYERS) { room.status = "lobby"; room.phase = "lobby"; room.log = "Back to the lobby — need 4+."; bump(room); return; }
    setupGame(room);
    bump(room);
  });

  function handleLeave() {
    const room = currentRoom();
    if (!room) return detach();
    const p = room.players.find((q) => q.id === socket.data.playerId);
    if (!p) return detach();
    if (room.voice) room.voice.delete(room.players.indexOf(p));
    if (room.status === "lobby") {
      room.players = room.players.filter((q) => q.id !== p.id);
      if (room.players.length === 0) { detach(); deleteRoom(room.code); return; }
      if (room.host === p.id) room.host = room.players[0].id;
      room.log = `${p.name} left.`;
    } else {
      const seat = room.players.indexOf(p);
      p.left = true; p.connected = false;
      if (room.players.every((q) => q.left)) { detach(); deleteRoom(room.code); return; }
      if (room.host === p.id) room.host = (room.players.find((q) => !q.left) || room.players[0]).id;
      room.log = `${p.name} left the game.`;
      if (room.status === "playing") {
        const wasSpy = room.spymaster.A === seat || room.spymaster.B === seat;
        const team = room.teamOf[seat];
        const mates = room.players.map((q, s) => (!q.left && room.teamOf[s] === team ? s : -1)).filter((s) => s >= 0);
        if (mates.length === 0 || (wasSpy && mates.length < 1)) {
          endGame(room, team === "A" ? "B" : "A", "forfeit", `${tname(team)} team fell apart — ${tname(team === "A" ? "B" : "A")} wins by default.`);
        } else if (wasSpy) {
          room.spymaster[team] = mates[0];
          room.log = `${p.name} (spymaster) left — ${room.players[mates[0]].name} takes over the map for ${tname(team)}.`;
        } else if (mates.length === 1) {
          endGame(room, team === "A" ? "B" : "A", "forfeit", `${tname(team)} has no guessers left — ${tname(team === "A" ? "B" : "A")} wins.`);
        }
      }
    }
    detach();
    bump(room);
  }
  socket.on("leave", () => handleLeave());
  socket.on("disconnect", () => {
    const room = currentRoom();
    if (!room) return;
    const p = room.players.find((q) => q.id === socket.data.playerId);
    if (p) { p.connected = false; if (room.voice) room.voice.delete(room.players.indexOf(p)); room.v++; }
    detach();
    if (rooms.has(room.code)) { refreshAfkClock(room); sendState(room.code); }
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) if (now - room.touched > 2 * 60 * 60 * 1000) deleteRoom(code);
}, 10 * 60 * 1000);

server.listen(PORT, () => console.log("Word Spies running on port " + PORT));
