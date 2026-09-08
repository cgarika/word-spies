/*
 Word Spies — rules & secrecy suite (proven against v1)
 Run:  PORT=3411 node server.js     then:  node test/rules.js
 Proves: 9/8/7/1 key dealt to spymasters only (identical for both), guess
 resolution (own word continues, neutral/enemy flips, trap ends the game
 with the map going public), count-0 unlimited + pass, win-by-gift when
 the enemy reveals your last word, clue validation (board words and
 non-letters rejected), role walls (spymaster/enemy taps ignored), and
 spymaster handover when one leaves mid-game.
*/
const { io } = require("socket.io-client");
const URL = "http://localhost:3411";
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

function mk(name){
  const s = io(URL,{ transports:["websocket"] });
  s.nm=name; s.st=null; s.seat=-1; s.leaks=[]; s.errs=[];
  s.on("err",(m)=>s.errs.push(m));
  s.on("state",({room,mySeat})=>{
    s.st=room; s.seat=mySeat;
    if (room.status==="playing" && !room.youAreSpymaster && room.key!==null)
      s.leaks.push("guesser received the key");
    if (room.players) for (const p of room.players)
      for (const k of Object.keys(p)) if(["key","truth"].includes(k)) s.leaks.push("player field "+k);
  });
  return s;
}
async function boot(n, pfx){
  const cs=[]; for(let i=0;i<n;i++) cs.push(mk(pfx+i));
  await sleep(300);
  let code=null; cs[0].on("joined",j=>{code=j.code;});
  cs[0].emit("create",{name:pfx+"0",playerId:pfx+"id0",avatar:"🕵️"}); await sleep(250);
  for(let i=1;i<n;i++) cs[i].emit("join",{code,name:pfx+i,playerId:pfx+"id"+i,avatar:"🕵️"});
  await sleep(300);
  cs[0].emit("start"); await sleep(300);
  return cs;
}
const spyOf = (cs,team)=>cs.find(c=>c.st.youAreSpymaster && c.st.yourTeam===team);
const guesserOf = (cs,team)=>cs.find(c=>!c.st.youAreSpymaster && c.st.yourTeam===team);
const idxWhere = (key,revealed,t)=>key.findIndex((v,i)=>v===t && !revealed[i]);

(async()=>{
  try{
    // ---- Test 1: setup + secrecy ----
    let cs = await boot(4,"s");
    const r0 = cs[0].st;
    const teams = r0.players.map(p=>p.team);
    if (teams.filter(t=>t==="A").length!==2 || teams.filter(t=>t==="B").length!==2) throw new Error("teams not 2/2");
    if (r0.players.filter(p=>p.spymaster).length!==2) throw new Error("need exactly 2 spymasters");
    const sA=spyOf(cs,"A"), sB=spyOf(cs,"B");
    if (!sA||!sB) throw new Error("spymaster clients not found");
    if (JSON.stringify(sA.st.key)!==JSON.stringify(sB.st.key)) throw new Error("spymasters see different keys!");
    const key=sA.st.key;
    const nStart=key.filter(v=>v===r0.startTeam).length, nOther=key.filter(v=>v!==r0.startTeam&&(v==="A"||v==="B")).length;
    if (nStart!==9||nOther!==8||key.filter(v=>v==="N").length!==7||key.filter(v=>v==="X").length!==1)
      throw new Error(`key composition wrong: ${nStart}/${nOther}`);
    if (new Set(r0.words).size!==25) throw new Error("board words not unique");
    console.log("PASS setup+secrecy — 9/8/7/1 key, spymasters only, start:", r0.startTeam);

    // ---- Test 2: guess resolution + assassin ending ----
    const T=cs[0].st.startTeam, O=T==="A"?"B":"A";
    spyOf(cs,T).emit("clue",{word:"ZEBRAX",count:2}); await sleep(250);
    let st=cs[0].st;
    if (st.phase!=="guess"||st.guessesLeft!==3) throw new Error("clue didn't open guessing: "+st.guessesLeft);
    const g=guesserOf(cs,T);
    let i=idxWhere(key,st.revealed,T);
    g.emit("tapWord",{i}); await sleep(250);
    st=cs[0].st;
    if (st.revealed[i]!==T) throw new Error("own-word reveal wrong");
    if (st.guessesLeft!==2||st.turnTeam!==T) throw new Error("should continue after own word");
    i=idxWhere(key,st.revealed,"N");
    g.emit("tapWord",{i}); await sleep(250);
    st=cs[0].st;
    if (st.turnTeam!==O||st.phase!=="clue") throw new Error("neutral should flip turn");
    spyOf(cs,O).emit("clue",{word:"QUOKKA",count:1}); await sleep(250);
    i=idxWhere(key,cs[0].st.revealed,"X");
    guesserOf(cs,O).emit("tapWord",{i}); await sleep(300);
    st=cs[0].st;
    if (st.status!=="over"||st.winner!==T||st.winReason!=="assassin") throw new Error("assassin ending wrong: "+st.winner+"/"+st.winReason);
    for (const c of cs) if (c.st.key===null) throw new Error("key not revealed to all at game over");
    for (const c of cs){ if (c.leaks.length) throw new Error(c.nm+": "+c.leaks[0]); }
    console.log("PASS resolution — own word continues, neutral flips, TRAP ends it, map goes public");
    cs.forEach(c=>c.close());

    // ---- Test 3: count-0 unlimited, pass, and win-by-gift ----
    cs = await boot(4,"w");
    const rr=cs[0].st, T2=rr.startTeam, O2=T2==="A"?"B":"A";
    const key2=spyOf(cs,T2).st.key;
    spyOf(cs,T2).emit("clue",{word:"MARATHON",count:9}); await sleep(250);
    const g2=guesserOf(cs,T2);
    for (let k=0;k<8;k++){
      const j=idxWhere(key2,cs[0].st.revealed,T2);
      g2.emit("tapWord",{i:j}); await sleep(150);
      if (cs[0].st.status!=="playing") throw new Error("ended early at k="+k);
      if (cs[0].st.turnTeam!==T2) throw new Error("turn flipped early at k="+k);
    }
    g2.emit("pass"); await sleep(250);
    if (cs[0].st.turnTeam!==O2) throw new Error("pass didn't flip turn");
    spyOf(cs,O2).emit("clue",{word:"OOPSY",count:0}); await sleep(250);
    if (cs[0].st.guessesLeft<20) throw new Error("count 0 should mean unlimited");
    const lastA=idxWhere(key2,cs[0].st.revealed,T2);
    guesserOf(cs,O2).emit("tapWord",{i:lastA}); await sleep(300);
    const fin=cs[0].st;
    if (fin.status!=="over"||fin.winner!==T2||fin.winReason!=="gifted") throw new Error("gifted win wrong: "+fin.winner+"/"+fin.winReason);
    console.log("PASS endgame math — 8 in a row, pass works, enemy gifting your last word loses");
    cs.forEach(c=>c.close());

    // ---- Test 4: validation + role walls ----
    cs = await boot(4,"v");
    const rv=cs[0].st, T3=rv.startTeam;
    const spy=spyOf(cs,T3);
    const boardWord=rv.words[5].toUpperCase();
    spy.errs.length=0;
    spy.emit("clue",{word:boardWord,count:1}); await sleep(200);
    if (!spy.errs.length) throw new Error("board-word clue was accepted");
    spy.emit("clue",{word:"AB1",count:1}); await sleep(200);
    if (spy.errs.length<2) throw new Error("non-letter clue was accepted");
    spy.emit("clue",{word:"GALAXY",count:1}); await sleep(200);
    const before=JSON.stringify(cs[0].st.revealed);
    spy.emit("tapWord",{i:0}); await sleep(200);                    // spymaster taps: ignored
    guesserOf(cs,T3==="A"?"B":"A").emit("tapWord",{i:0}); await sleep(200); // wrong team: ignored
    if (JSON.stringify(cs[0].st.revealed)!==before) throw new Error("role wall breached");
    console.log("PASS validation — board-word & junk clues rejected, spymaster/enemy taps ignored");
    // ---- Test 5: spymaster leaves -> mate takes over ----
    const spySeat=spy.seat;
    spy.emit("leave"); await sleep(300);
    const after=cs.find(c=>c!==spy && c.st).st;
    const newSpies=after.players.filter(p=>p.spymaster&&!p.left).length;
    if (newSpies!==2) throw new Error("spymaster handover failed: "+newSpies);
    if (after.status!=="playing") throw new Error("game should continue after handover");
    console.log("PASS handover — leaving spymaster replaced by teammate, game continues");
    cs.forEach(c=>c.close());

    // ---- Test 6 (T1 AFK policy): own fast-clock server on 3431 ----
    {
      const { spawn } = require("child_process");
      const CLUE=700, AFK=250, P=3431, URL2="http://localhost:"+P;
      const srv = spawn(process.execPath, ["server.js"], { env: { ...process.env, PORT:String(P), CLUE_MS:String(CLUE), GUESS_MS:String(CLUE), AFK_MS:String(AFK) }, stdio:"ignore" });
      await sleep(600);
      const mk2=(name)=>{ const c=io(URL2,{transports:["websocket"],reconnection:false}); c.nm=name; c.st=null; c.seat=-1; c.logs=[]; c.on("state",({room,mySeat})=>{ c.st=room; c.seat=mySeat; if(room&&room.log) c.logs.push(room.log); }); return c; };
      const wait=async(fn,ms)=>{ const t0=Date.now(); while(Date.now()-t0<ms){ if(fn()) return true; await sleep(15);} return false; };
      const boot2=async(pfx)=>{ const cs=[]; for(let i=0;i<4;i++) cs.push(mk2(pfx+i)); await sleep(250); let code=null; cs[0].on("joined",j=>{code=j.code;}); cs[0].emit("create",{name:pfx+"0",playerId:pfx+"id0"+Math.random(),avatar:"🕵️"}); await wait(()=>code,2000); for(let i=1;i<4;i++) cs[i].emit("join",{code,name:pfx+i,playerId:pfx+"id"+i+Math.random(),avatar:"🕵️"}); await wait(()=>cs[0].st&&cs[0].st.players.length===4,2000); cs[0].emit("start"); await wait(()=>cs.every(c=>c.st&&c.st.status==="playing"&&c.st.yourTeam),2000); return cs; };
      try {
        // 6a. the turn team's spymaster disconnects → the clue phase ends on the AFK clock and the turn passes
        { const cs=await boot2("a"); const t=cs[0].st.turnTeam; const spy=cs.find(c=>c.st.youAreSpymaster&&c.st.yourTeam===t); const W=cs.find(c=>c!==spy);
          spy.disconnect(); const t0=Date.now();
          if(!(await wait(()=>W.st&&W.st.turnTeam!==t, CLUE+800))) throw new Error("AFK: turn did not pass with a disconnected spymaster"); const dt=Date.now()-t0; if(dt>=CLUE) throw new Error("AFK: waited the full clock ("+dt+" ms)");
          console.log("PASS AFK disconnected spymaster — turn passed after "+dt+" ms (clock "+CLUE+")"); cs.forEach(c=>c.disconnect()); }
        // 6b. a connected spymaster who never gives a clue: 3 missed turns → marked away, map handed to the teammate; takeSeat brings them back
        { const cs=await boot2("b"); const t=cs[0].st.turnTeam; const spy=cs.find(c=>c.st.youAreSpymaster&&c.st.yourTeam===t); const o=t==="A"?"B":"A";
          const oSpy=cs.find(c=>c.st.youAreSpymaster&&c.st.yourTeam===o), oG=cs.find(c=>!c.st.youAreSpymaster&&c.st.yourTeam===o);
          // the other team plays instantly: clue then pass
          oSpy.on("state",()=>{ const r=oSpy.st; if(r&&r.status==="playing"&&r.phase==="clue"&&r.turnTeam===o) setTimeout(()=>oSpy.emit("clue",{word:"ZEBRAXQ",count:1}),10); });
          oG.on("state",()=>{ const r=oG.st; if(r&&r.status==="playing"&&r.phase==="guess"&&r.turnTeam===o) setTimeout(()=>oG.emit("pass"),10); });
          const spySeat=spy.seat;
          if(!(await wait(()=>spy.st&&spy.st.players[spySeat]&&spy.st.players[spySeat].botControlled, CLUE*10))) throw new Error("AFK: idle spymaster never marked away (status "+(spy.st&&spy.st.status)+", seat "+spySeat+", team "+t+", last logs: "+spy.logs.slice(-3).join(" | ")+")");
          if(!(await wait(()=>spy.logs.some(l=>/is away/.test(l)),500))) throw new Error("AFK: no away log");
          const handed=spy.st.players.some((p,i)=>p.spymaster&&i!==spySeat&&p.team===t); if(!handed) throw new Error("AFK: map was not handed to the teammate");
          spy.emit("takeSeat"); if(!(await wait(()=>!spy.st.players[spySeat].botControlled,1500))) throw new Error("AFK: takeSeat did not clear the flag");
          console.log("PASS AFK 3 missed clues → away + map handed over, takeSeat brings the player back"); cs.forEach(c=>c.disconnect()); }
      } finally { srv.kill(); }
    }

    // ---- T3 host handover: host disconnects during play → another human becomes host ----
    {
      const { spawn } = require("child_process");
      const P=3441, URL2="http://localhost:"+P;
      const srv = spawn(process.execPath, ["server.js"], { env: { ...process.env, PORT:String(P), CLUE_MS:"60000", GUESS_MS:"60000" }, stdio:"ignore" });
      await sleep(600);
      const mk2=(name)=>{ const c=io(URL2,{transports:["websocket"],reconnection:false}); c.st=null; c.seat=-1; c.logs=[]; c.on("state",({room,mySeat})=>{ c.st=room; c.seat=mySeat; if(room&&room.log) c.logs.push(room.log); }); return c; };
      const wait=async(fn,ms=6000)=>{ const t0=Date.now(); while(Date.now()-t0<ms){ if(fn()) return true; await sleep(15);} return false; };
      try {
        const n=4; const cs=[]; for(let i=0;i<n;i++) cs.push(mk2("H"+i)); await sleep(250); let code=null; cs[0].on("joined",j=>{code=j.code;});
        cs[0].emit("create",{name:"H0",playerId:"h0"+Math.random(),avatar:"🦊"}); await wait(()=>code); for(let i=1;i<n;i++) cs[i].emit("join",{code,name:"H"+i,playerId:"h"+i+Math.random(),avatar:"🐼"}); await wait(()=>cs[0].st&&cs[0].st.players.length===n);
        
        cs[0].emit("start"); if(!(await wait(()=>cs[1].st&&cs[1].st.status==="playing"))) throw new Error("T3: game did not start");
        if(cs[1].st.hostSeat!==cs[0].seat) throw new Error("T3: creator is not the host at start");
        cs[0].disconnect();
        if(!(await wait(()=>cs[1].st.hostSeat===cs[1].seat, 3000))) throw new Error("T3: host did not move to the connected human (hostSeat "+cs[1].st.hostSeat+")");
        if(!cs[1].logs.some(l=>/is now the host/.test(l))) throw new Error("T3: no host log line");
        console.log("PASS T3 host handover — host disconnected mid-game, next connected human is host");
        
        cs.forEach(c=>c.disconnect());
      } finally { srv.kill(); }
    }
    // ---- T5: push recipients come from the room's team/spymaster maps; pause instead of forfeit; host reassign + endGame ----
    {
      const { spawn } = require("child_process"); const http = require("http");
      const P=3451, URL2="http://localhost:"+P, PP=3452;
      const pushes=[]; const rec=http.createServer((req,res)=>{ let b=""; req.on("data",c=>b+=c); req.on("end",()=>{ try{ pushes.push(JSON.parse(b)); }catch(_){} res.end("{}"); }); }); await new Promise(r=>rec.listen(PP,r));
      const srv = spawn(process.execPath, ["server.js"], { env: { ...process.env, PORT:String(P), CLUE_MS:"60000", GUESS_MS:"60000", PUSH_URL:"http://localhost:"+PP }, stdio:"ignore" });
      await sleep(600);
      const mk2=(name)=>{ const c=io(URL2,{transports:["websocket"],reconnection:false}); c.nm=name; c.st=null; c.seat=-1; c.logs=[]; c.errs=[]; c.on("err",m=>c.errs.push(m)); c.on("state",({room,mySeat})=>{ c.st=room; c.seat=mySeat; if(room&&room.log) c.logs.push(room.log); }); return c; };
      const wait=async(fn,ms=6000)=>{ const t0=Date.now(); while(Date.now()-t0<ms){ if(fn()) return true; await sleep(15);} return false; };
      const boot2=async(pfx,n,pre)=>{ const cs=[]; for(let i=0;i<n;i++) cs.push(mk2(pfx+i)); await sleep(250); let code=null; cs[0].on("joined",j=>{code=j.code;}); cs[0].emit("create",{name:pfx+"0",playerId:pfx+"id0"+Math.random(),avatar:"🕵️"}); await wait(()=>code); for(let i=1;i<n;i++) cs[i].emit("join",{code,name:pfx+i,playerId:pfx+"id"+i+Math.random(),avatar:"🕵️"}); await wait(()=>cs[0].st&&cs[0].st.players.length===n); if(pre) await pre(cs); cs[0].emit("start"); await wait(()=>cs.every(c=>c.st&&c.st.status==="playing"&&c.st.yourTeam)); return cs; };
      const spy2=(cs,t)=>cs.find(c=>c.st.youAreSpymaster&&c.st.yourTeam===t), guess2=(cs,t)=>cs.find(c=>!c.st.youAreSpymaster&&c.st.yourTeam===t);
      const tok=(nm)=>Buffer.from(nm).toString("hex").padEnd(40,"0");   // tokens must look like device tokens (32+ hex chars)
      try {
        // 7a. pushes: everyone registers a token and goes "away"; only the turn team's spymaster is told to clue, only its guesser is told to guess
        { const cs=await boot2("p",4,async(cs)=>{ for(const c of cs){ c.emit("pushToken",{token:tok(c.nm)}); c.emit("presence",{away:true}); } await sleep(150); });
          const t=cs[0].st.turnTeam, sp=spy2(cs,t), g=guess2(cs,t);
          if(!(await wait(()=>pushes.some(x=>/give a clue/.test(x.body)),3000))) throw new Error("T5: no clue push at all (pushes: "+JSON.stringify(pushes).slice(0,200)+")");
          const clueTo=pushes.filter(x=>/give a clue/.test(x.body)).map(x=>x.token);
          if(clueTo.join()!==tok(sp.nm)) throw new Error("T5: clue push went to "+clueTo.join()+", expected only "+sp.nm);
          sp.emit("clue",{word:"ZEBRAXQ",count:1}); if(!(await wait(()=>g.st.phase==="guess"))) throw new Error("T5: clue not accepted");
          if(!(await wait(()=>pushes.some(x=>/Clue is in/.test(x.body)),3000))) throw new Error("T5: no guess push");
          const guessTo=pushes.filter(x=>/Clue is in/.test(x.body)).map(x=>x.token);
          if(guessTo.join()!==tok(g.nm)) throw new Error("T5: guess push went to "+guessTo.join()+", expected only "+g.nm);
          console.log("PASS T5 push recipients — clue push to the turn spymaster only, guess push to the turn guesser only"); cs.forEach(c=>c.disconnect()); }
        // 7b. 5 players (3/2): a member of the 2-team leaves → paused, actions blocked; host moves one over → play resumes
        { const cs=await boot2("q",5); const r=cs[0].st; const nA=r.players.filter(p=>p.team==="A").length; const small=nA===2?"A":"B", big=small==="A"?"B":"A";
          const leaver=cs.find(c=>c.st.yourTeam===small && c!==cs[0]); const leaverSeat=leaver.seat; const W=cs.find(c=>c!==leaver && c!==cs[0]);
          leaver.emit("leave"); if(!(await wait(()=>W.st.phase==="paused"))) throw new Error("T5: game did not pause (phase "+W.st.phase+", log "+W.st.log+")");
          if(W.st.status!=="playing") throw new Error("T5: pause should keep status playing"); if(!W.st.pauseReason||!/short-handed/.test(W.st.pauseReason)) throw new Error("T5: no pause reason: "+W.st.pauseReason);
          if(W.st.phaseEndsAt) throw new Error("T5: clock should stop while paused");
          const t=W.st.turnTeam; const sp=spy2(cs.filter(c=>c!==leaver),t); const v=W.st.v||0;
          if(sp){ sp.emit("clue",{word:"ZEBRAXQ",count:1}); await sleep(250); if(W.st.phase!=="paused") throw new Error("T5: clue accepted while paused"); }
          // non-host reassign is ignored
          const mover=cs.find(c=>c.st.yourTeam===big && c!==cs[0]); const nonHost=cs.find(c=>c!==cs[0]&&c!==leaver);
          nonHost.emit("reassign",{seat:mover.seat,team:small}); await sleep(250); if(W.st.players[mover.seat].team!==big) throw new Error("T5: non-host reassign applied");
          cs[0].emit("reassign",{seat:mover.seat,team:small});
          if(!(await wait(()=>W.st.phase!=="paused"))) throw new Error("T5: game did not resume after reassign (phase "+W.st.phase+", log "+W.st.log+")");
          if(W.st.players[mover.seat].team!==small) throw new Error("T5: player not moved"); if(W.st.pauseReason) throw new Error("T5: pauseReason not cleared");
          const live=W.st.players.filter(p=>!p.left); if(live.filter(p=>p.team==="A").length!==2||live.filter(p=>p.team==="B").length!==2) throw new Error("T5: teams not 2/2 after move");
          if(live.filter(p=>p.spymaster&&p.team==="A").length!==1||live.filter(p=>p.spymaster&&p.team==="B").length!==1) throw new Error("T5: each team needs exactly one spymaster");
          if(!["clue","guess"].includes(W.st.phase)) throw new Error("T5: resumed into phase "+W.st.phase);
          if(!W.st.phaseEndsAt) throw new Error("T5: clock not re-armed after resume");
          if(!W.st.logs?.length && !W.logs.some(l=>/Back on/.test(l))) throw new Error("T5: no resume log");
          // hand the map to a guesser on the small team
          const g=cs.find(c=>c!==leaver&&c.st.yourTeam===small&&!c.st.youAreSpymaster); cs[0].emit("reassign",{seat:g.seat,spymaster:true});
          if(!(await wait(()=>g.st.youAreSpymaster))) throw new Error("T5: give-map reassign not applied");
          if(W.st.players.filter(p=>!p.left&&p.spymaster&&p.team===small).length!==1) throw new Error("T5: two spymasters on one team after give-map");
          if(!g.st.key) throw new Error("T5: new spymaster did not receive the key");
          // endGame: non-host ignored, host ends it with no winner
          nonHost.emit("endGame"); await sleep(250); if(W.st.status!=="playing") throw new Error("T5: non-host ended the game");
          cs[0].emit("endGame"); if(!(await wait(()=>W.st.status==="over"))) throw new Error("T5: host endGame did not end the game");
          if(W.st.winner!==null||W.st.winReason!=="ended") throw new Error("T5: endGame should record no winner, reason ended: "+W.st.winner+"/"+W.st.winReason);
          console.log("PASS T5 pause on short-handed team, actions blocked, host reassign resumes, give-map, host endGame"); cs.forEach(c=>c.disconnect()); }
        // 7c. no forfeit anywhere: a guesser leaving a 2-player team pauses rather than awarding the game
        { const cs=await boot2("f",4); const t=cs[0].st.turnTeam; const g=guess2(cs,t)===cs[0]?spy2(cs,t):guess2(cs,t); const W=cs.find(c=>c!==g);
          g.emit("leave"); if(!(await wait(()=>W.st.phase==="paused"))) throw new Error("T5: leave from a 2-player team should pause, got "+W.st.status+"/"+W.st.phase);
          if(W.st.winner) throw new Error("T5: a winner was awarded on leave");
          console.log("PASS T5 no forfeit — leaving pauses instead of handing the win over"); cs.forEach(c=>c.disconnect()); }
      } finally { srv.kill(); rec.close(); }
    }
    console.log("ALL WORD SPIES TESTS PASS");
    process.exit(0);
  }catch(e){ console.error("FAIL:", e.message); process.exit(1); }
})();
