// v117: SERVER AI LIKE A PERSON - no phone open: bots think 2-8 s; an away player keeps 2 full 15 s card turns, then 2-8 s until he is back.
// v20d: the log now shows the time left for a returning player ([v20d TURN] / [v20d CLOCK KEPT]).
// v20c: REAL-CLOCK TURNS - pausing never refills the 15-second bid or card timer.
// v19: SAFE JOIN + PRIVATE TABLES
//  - A chair belongs to a player ONLY by his login id (uid). Names are never used to match chairs (two players can share a name).
//  - Tables made with a 4-digit code are PRIVATE: Quick Match (SOLO / PARTNERS) can never seat a stranger there.
//  - The welcome + live-hand replay are sent only after the phone says "ready" (its listeners are registered),
//    so nothing is lost. If an older app build never says ready, the welcome is sent automatically after 4 seconds.
//  - 4-digit code registry (TABLE_CODES) so JOIN TABLE can find private tables.
// v18: BLIND SCORES ON THE SERVER. v17: FINISHED TABLE VANISHES + server keeps match score.
// v16: STRICT 15-SECOND TURNS. v15: NO RE-DEAL ON RETURN. v14: SERVER PLAYS when no phone is open.
// v12: TABLE LOCK (Zynga rules). v7-v11: keep my seat, unique names, watch-only server copy of the hand.
import { Room, Client, CloseCode } from "colyseus";
import { MyRoomState } from "./schema/MyRoomState.js";

interface PlayerSeat {
  sessionId: string;
  seatIndex: number; // 0: Rex/South, 1: Carlos/West, 2: Jack/North, 3: Viktor/East
  name: string;
  isBot: boolean;
  avatarUrl?: string;
  coins: number;
  uid: string;      // the player's login id (same id = same chair when he comes back)
  away: boolean;    // phone call / app closed - AI plays his chair until he returns
  left?: boolean;   // pressed LEAVE TABLE - AI plays his chair to the end, he is still locked to this table
  rejoined?: boolean; // v19: this join is a return to his own chair
}

const AWAY_TABLE_LIMIT_MS = 30 * 60 * 1000;   // everyone away for 30 minutes -> table closes
const AFTER_WINNER_CLOSE_MS = 20 * 1000;      // table vanishes 20s after the winner celebration


// ---- exact copy of the phones' System.Random(seed), so the server deals the very same cards ----
class NetRandom {
  private seedArray = new Array<number>(56).fill(0);
  private inext = 0; private inextp = 21;
  constructor(seed: number) {
    const MBIG = 2147483647, MSEED = 161803398;
    const subtraction = seed === -2147483648 ? 2147483647 : Math.abs(seed);
    let mj = MSEED - subtraction; this.seedArray[55] = mj; let mk = 1;
    for (let i = 1; i < 55; i++) {
      const ii = (21 * i) % 55; this.seedArray[ii] = mk; mk = mj - mk; if (mk < 0) mk += MBIG; mj = this.seedArray[ii];
    }
    for (let k = 1; k < 5; k++) for (let i = 1; i < 56; i++) {
      let v = this.seedArray[i] - this.seedArray[1 + ((i + 30) % 55)];
      v = v | 0; if (v < 0) v += MBIG; this.seedArray[i] = v;
    }
  }
  private internalSample(): number {
    const MBIG = 2147483647;
    let a = this.inext, b = this.inextp;
    if (++a >= 56) a = 1; if (++b >= 56) b = 1;
    let r = this.seedArray[a] - this.seedArray[b];
    if (r === MBIG) r--; if (r < 0) r += MBIG;
    this.seedArray[a] = r; this.inext = a; this.inextp = b; return r;
  }
  next(min: number, max: number): number { return Math.floor(this.internalSample() * (1.0 / 2147483647) * (max - min)) + min; }
}
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "j", "q", "k", "a"];
function shuffledDeck(rng: NetRandom): string[] {
  const deck: string[] = [];
  for (const s of ["s", "h", "d", "c"]) for (const r of RANKS) deck.push(r + s);
  for (let i = deck.length - 1; i > 0; i--) { const j = rng.next(0, i + 1); const t = deck[i]; deck[i] = deck[j]; deck[j] = t; }
  return deck;
}
const suitOf = (c: string) => c.charAt(c.length - 1);
const rankOf = (c: string) => RANKS.indexOf(c.substring(0, c.length - 1));

// one live table per player id across the whole server: uid -> room that owns him
const TABLE_LOCKS = new Map<string, { roomId: string; code: string }>();
// v19: 4-digit code -> room id (private tables are found through this list)
export const TABLE_CODES = new Map<string, string>();
const TURN_CLOCK_MS = Number(process.env.SAM_TURN_MS) || 15 * 1000;

export class MyRoom extends Room<{ state: MyRoomState }> {
  maxClients = 4;
  autoDispose = false; // an empty-looking table (everyone on a call) must stay alive
  state = new MyRoomState();

  tableMode: "classic_pro" | "beat_and_laugh" = "classic_pro";
  tableCode: string = "0000";
  targetScore: number = 200;
  stakeCoins: number = 500;

  seats: (PlayerSeat | null)[] = [null, null, null, null];

  lastDeal: any = null;
  roundLog: any[] = [];
  lastReturnAt = 0;
  blind: string[] = ["", "", "", ""]; // "" = normal, "N" = blind nil, number = blind bid
  welcomed = new Set<string>();       // v19: sessions that already received their welcome

  // the server's own view of the live hand
  hands: string[][] = [[], [], [], []];
  bids: number[] = [-1, -1, -1, -1];
  tricksWon: number[] = [0, 0, 0, 0];
  trick: { s: number; c: string }[] = [];
  turnSeat = -1;
  phase: "idle" | "bidding" | "playing" = "idle";
  turnClock: any = null;
  awayTurns = [0, 0, 0, 0]; // v117: card turns the server already waited in full for a player who is away (2 full chances, then natural timing)
  turnDeadline = 0; // v20: real time (ms) when the current turn runs out - told to a returning phone so pausing never gives extra time
  spadesBroken = false;
  // the server's own match score (server seat order)
  handNo = 1; soloScore = [0, 0, 0, 0]; soloBags = [0, 0, 0, 0]; teamScore = [0, 0]; teamBags = [0, 0];
  dealer = 0; partners = false; idleTimer: any = null;

  leavingOnPurpose = new Set<string>(); // sessions that pressed LEAVE TABLE / log out
  closeTimer: any = null;               // winner celebration -> close
  emptyTimer: any = null;               // everyone away -> close

  // "Rex|Carlos||" - empty = free chair; "~Name" = chair kept for a player who is away
  roster(): string {
    return this.seats.map((s) => (s ? (s.away ? "~" : "") + (s.name || "Player").replace(/[|~]/g, " ") : "")).join("|");
  }
  sendRoster() {
    this.broadcast("roster", { names: this.roster() });
  }

  onCreate(options: any) {
    if (options.mode === "beat_and_laugh" || options.mode === "classic_pro") this.tableMode = options.mode;
    if (options.tableCode && options.tableCode.length === 4) this.tableCode = options.tableCode;
    else this.tableCode = Math.floor(1000 + Math.random() * 9000).toString();
    if (options.targetScore) this.targetScore = Number(options.targetScore) || 200;
    if (options.stakeCoins) this.stakeCoins = Number(options.stakeCoins) || 500;

    this.setMetadata({
      tableMode: this.tableMode,
      tableCode: this.tableCode,
      targetScore: this.targetScore,
      stakeCoins: this.stakeCoins,
      format: options.format === "partners" ? "partners" : "solo",
    });
    this.partners = options.format === "partners";

    // v19: a table made with a 4-digit code is PRIVATE - Quick Match can never put a stranger in it
    if (options.tableCode && String(options.tableCode).length === 4) this.setPrivate(true);
    TABLE_CODES.set(this.tableCode, this.roomId);

    console.log(`[SPADES ROOM CREATED] ID: ${this.roomId} | Code: ${this.tableCode} | Mode: ${this.tableMode} | Stake: ${this.stakeCoins} | Private: ${!!options.tableCode}`);

    this.onMessage("play_card", (client, message) => {
      this.broadcast("card_played", { sessionId: client.sessionId, card: message.card, seatIndex: message.seatIndex });
    });
    this.onMessage("make_bid", (client, message) => {
      this.broadcast("bid_made", { sessionId: client.sessionId, bid: message.bid, seatIndex: message.seatIndex });
    });

    // v19: the phone has registered its listeners - now it is safe to send the welcome + live hand
    this.onMessage("ready", (client) => this.sendWelcome(client));

    this.onMessage("net", (client, message) => {
      if (message && message.k === "bb") { // blind choice - kept on the server only, never sent to other phones
        const bs = Number(message.s); if (bs >= 0 && bs < 4) this.blind[bs] = String(message.v || "");
        console.log(`[v18 BLIND] Room ${this.tableCode}: seat ${bs} blind ${message.v}`);
        return;
      }
      if (message && message.k === "deal") {
        // a hand is still running and a player just came back -> his phone's new deal is refused (stops the re-deal)
        if (this.phase !== "idle" && Date.now() - this.lastReturnAt < 15000) {
          console.log(`[v15 DEAL REFUSED] Room ${this.tableCode}: hand still running, returning player keeps the live hand`);
          if (this.lastDeal) { client.send("replay", this.lastDeal); for (const m of this.roundLog) if (m !== this.lastDeal) client.send("replay", m); }
          return;
        }
        this.lastDeal = message; this.roundLog = [];
        if (this.closeTimer) return; // match finished - no new game on this table
      }
      if (message && message.k !== "tq") this.roundLog.push(message);
      try { this.watch(message); } catch (e) { console.log(`[v11 WATCH] skipped: ${e}`); } // never breaks the relay
      this.broadcast("net", message, { except: client });
    });

    // player pressed LEAVE TABLE or logged out -> his chair is really freed
    this.onMessage("leave_seat", (client) => {
      this.leavingOnPurpose.add(client.sessionId);
    });

    // winner celebration started -> table vanishes after it (cancelled if a new deal arrives)
    this.onMessage("match_over", () => {
      if (this.closeTimer) return;
      console.log(`[MATCH OVER] Room ${this.tableCode} closes in ${AFTER_WINNER_CLOSE_MS / 1000}s`);
      this.closeTimer = setTimeout(() => this.closeTable("match finished"), AFTER_WINNER_CLOSE_MS);
    });

    this.onMessage("taunt", (client, message) => {
      this.broadcast("player_taunt", { sessionId: client.sessionId, targetSeat: message.targetSeat, action: message.action });
    });
  }

  onJoin(client: Client, options: any) {
    const uid = String(options.uid || "") || "dev_" + client.sessionId; // every chair has an owner id
    const playerName = String(options.name || `Player_${client.sessionId.substring(0, 4)}`);

    // v19: identity = uid ONLY. Names are display text and are not unique (Google / email names can match).
    let assignedSeat = this.seats.findIndex((s) => s !== null && s.uid === uid);
    const rejoined = assignedSeat >= 0;

    if (!rejoined && this.closeTimer) throw new Error("TABLE FINISHED"); // finished table takes no new players

    // still locked to another live table -> refused (he can only go back to that one)
    const lock = TABLE_LOCKS.get(uid);
    if (!rejoined && lock && lock.roomId !== this.roomId) {
      console.log(`[v12 LOCK] ${playerName} refused in ${this.tableCode} - still seated at table ${lock.code}`);
      throw new Error("ACTIVE TABLE " + lock.code);
    }

    if (rejoined) {
      const seat = this.seats[assignedSeat]!;
      seat.sessionId = client.sessionId;
      seat.away = false;
      seat.left = false; // back in his own chair
      seat.name = playerName;
      seat.rejoined = true;
      this.awayTurns[assignedSeat] = 0; // v117: he is back - the next time he leaves he gets 2 fresh full chances
      console.log(`[PLAYER BACK] ${playerName} -> Seat ${assignedSeat} in Room ${this.tableCode}`);
      this.lastReturnAt = Date.now();
      console.log(`[v15 RETURN] live hand ${this.lastDeal ? "yes" : "NO"}, ${this.roundLog.length} moves to replay, phase ${this.phase}`);
    } else {
      for (let i = 0; i < 4; i++) if (!this.seats[i]) { assignedSeat = i; break; }
      if (assignedSeat < 0) throw new Error("TABLE FULL"); // chairs kept for away players are never given away
      this.seats[assignedSeat] = {
        sessionId: client.sessionId, seatIndex: assignedSeat, name: playerName, isBot: false,
        avatarUrl: options.avatarUrl || "", coins: Number(options.coins) || 10000, uid, away: false, rejoined: false,
      };
      console.log(`[PLAYER SEATED] ${playerName} -> Seat ${assignedSeat} (Session: ${client.sessionId}) in Room ${this.tableCode}`);
    }
    if (this.emptyTimer) { clearTimeout(this.emptyTimer); this.emptyTimer = null; }
    TABLE_LOCKS.set(uid, { roomId: this.roomId, code: this.tableCode });

    this.broadcast("seat_updated", { seatIndex: assignedSeat, player: this.seats[assignedSeat] });
    this.sendRoster();

    // v19: welcome + replay go out when the phone says "ready". Older app builds never say it, so send anyway after 4 seconds.
    const sid = client.sessionId;
    setTimeout(() => {
      // v19b: only if this phone is still connected
      if (!this.welcomed.has(sid) && this.clients.some((c) => c.sessionId === sid)) {
        try { this.sendWelcome(client); } catch (e) { console.log(`[v19b WELCOME] skipped: ${e}`); }
      }
    }, 4000);
  }

  // v19: welcome_table, the "AI keeps your chair" notice, and (for a returning player) the live hand
  sendWelcome(client: Client) {
    if (this.welcomed.has(client.sessionId)) return;
    const idx = this.seats.findIndex((s) => s && s.sessionId === client.sessionId);
    if (idx < 0) return;
    this.welcomed.add(client.sessionId);
    const seat = this.seats[idx]!;
    const rejoined = !!seat.rejoined; seat.rejoined = false;

    // v20d: how many milliseconds of the running turn are really left (also written to the log so it can be checked)
    const turnLeftNow = (() => {
      if (this.turnDeadline <= 0) return -1;
      const raw = Math.max(0, this.turnDeadline - Date.now());
      const firstBid = this.phase === "bidding" && this.bids.every((b) => b < 0);
      return firstBid ? Math.min(TURN_CLOCK_MS, raw) : raw; // a returning player skips the deal animation
    })();
    console.log(`[v20d TURN] Room ${this.tableCode}: welcome to seat ${idx} - turn of seat ${this.phase === "idle" ? -1 : this.turnSeat}, ${turnLeftNow} ms left, returning ${rejoined}`);
    client.send("welcome_table", {
      seatIndex: idx,
      tableCode: this.tableCode,
      tableMode: this.tableMode,
      targetScore: this.targetScore,
      stakeCoins: this.stakeCoins,
      names: this.roster(),
      rejoined,
      // v20: whose turn it is and how many milliseconds are really left (-1 = no running turn)
      turnSeat: this.phase === "idle" ? -1 : this.turnSeat,
      // v20c: a returning player skips the deal animation, so his first bid never gets more than 15 seconds
      turnLeftMs: turnLeftNow,
    });

    // hand already running -> the AI keeps this chair until the next deal, then he plays his own cards
    if (this.lastDeal && !this.closeTimer) this.broadcast("net", { k: "dl", s: idx, v: rejoined ? "2" : "1" });
    // returning player -> replay the live hand to HIM only
    if (rejoined && this.lastDeal && !this.closeTimer) {
      client.send("replay", this.lastDeal);
      for (const m of this.roundLog) if (m !== this.lastDeal) client.send("replay", m);
    }
  }

  onLeave(client: Client, code: CloseCode) {
    this.welcomed.delete(client.sessionId);
    const seatIdx = this.seats.findIndex((s) => s && s.sessionId === client.sessionId);
    if (seatIdx < 0) return; // an old connection of a player who already came back: nothing to do
    const p = this.seats[seatIdx]!;
    const onPurpose = this.leavingOnPurpose.delete(client.sessionId);
    const matchFinished = this.closeTimer !== null;

    if (matchFinished) {
      // match over -> chair and player are both free
      console.log(`[PLAYER LEFT] Seat ${seatIdx} (${p.name}) left finished room ${this.tableCode}`);
      if (TABLE_LOCKS.get(p.uid)?.roomId === this.roomId) TABLE_LOCKS.delete(p.uid);
      this.seats[seatIdx] = null;
      this.broadcast("seat_vacated", { seatIndex: seatIdx });
    } else if (onPurpose) {
      // LEAVE TABLE -> AI plays his chair to the end; he stays locked to this table
      console.log(`[v12 LEFT TABLE] Seat ${seatIdx} (${p.name}) - AI plays to the end, player locked to ${this.tableCode}`);
      p.away = true; p.left = true;
    } else {
      // call / app closed / network drop -> keep the chair, AI plays it
      console.log(`[PLAYER AWAY] Seat ${seatIdx} (${p.name}) - chair kept, AI plays in room ${this.tableCode}`);
      p.away = true;
    }
    this.sendRoster();
    if (!this.seats.some((s) => s && !s.away)) this.keepClockForServer(); // last phone closed -> the server clock takes over (v20b: with the SAME deadline, never a fresh 15 seconds)

    // humans = everyone seated who did NOT press LEAVE TABLE (a call / closed app still counts as a human)
    const humansLeft = this.seats.some((s) => s && !s.left);
    const anyoneConnected = this.seats.some((s) => s && !s.away);
    if (!humansLeft) this.closeTable("every human left the table");
    else if (!anyoneConnected && !this.emptyTimer)
      this.emptyTimer = setTimeout(() => this.closeTable("everyone away too long"), AWAY_TABLE_LIMIT_MS);
  }

  // free every player id that this table was holding
  releaseLocks() {
    for (const [uid, l] of TABLE_LOCKS) if (l.roomId === this.roomId) TABLE_LOCKS.delete(uid);
  }

  // ---- follow the live hand (nothing is sent to the phones from here) ----
  watch(m: any) {
    if (!m || typeof m.k !== "string") return;
    const s = Number(m.s);
    if (m.k === "deal") {
      const seed = parseInt(String(m.v || "").split(";")[0], 10);
      if (isNaN(seed) || isNaN(s)) return;
      const deck = shuffledDeck(new NetRandom(seed));
      this.hands = [[], [], [], []];
      for (let i = 0; i < 52; i++) this.hands[(s + 1 + i) % 4].push(deck[i]);
      this.bids = [-1, -1, -1, -1]; this.blind = ["", "", "", ""]; this.tricksWon = [0, 0, 0, 0]; this.trick = []; this.spadesBroken = false;
      this.dealer = s; this.readScores(String(m.v || "").split(";")[1]);
      if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
      this.phase = "bidding"; this.turnSeat = (s + 1) % 4;
      console.log(`[v11 DEAL] Room ${this.tableCode} dealer ${s} seed ${seed} - seat ${this.turnSeat} bids first`);
    } else if (m.k === "bid" && this.phase === "bidding") {
      this.bids[s] = parseInt(String(m.v), 10);
      this.turnSeat = (s + 1) % 4;
      if (this.bids.every((b) => b >= 0)) this.phase = "playing"; // first lead = seat after dealer = same seat
    } else if (m.k === "card" && this.phase === "playing") {
      const c = String(m.v).toLowerCase(); const h = this.hands[s]; const i = h.indexOf(c);
      if (i >= 0) h.splice(i, 1); else console.log(`[v11 WATCH] card ${c} not in server copy of seat ${s}`);
      this.trick.push({ s, c }); if (suitOf(c) === "s") this.spadesBroken = true;
      if (this.trick.length < 4) this.turnSeat = (s + 1) % 4;
      else {
        const lead = suitOf(this.trick[0].c); let w = this.trick[0];
        for (const t of this.trick) {
          const ts = suitOf(t.c), ws = suitOf(w.c);
          if ((ts === "s" && ws !== "s") || (ts === ws && rankOf(t.c) > rankOf(w.c))) w = t;
        }
        void lead; this.tricksWon[w.s]++; this.trick = []; this.turnSeat = w.s;
        if (this.hands.every((x) => x.length === 0)) { this.phase = "idle"; this.turnSeat = -1;
          console.log(`[v11 HAND END] Room ${this.tableCode} tricks ${this.tricksWon.join("/")}`);
          this.afterHand(); return; }
      }
    } else return;
    this.restartClock();
  }

  restartClock() {
    if (this.turnClock) { clearTimeout(this.turnClock); this.turnClock = null; }
    this.turnDeadline = 0;
    if (this.turnSeat < 0 || this.closeTimer) return;
    const seat = this.turnSeat, phase = this.phase;
    // v20: the very first bid also covers the deal animation + blind choice on the phones (about 20 seconds more)
    const firstBid = this.phase === "bidding" && this.bids.every((b) => b < 0);
    // v20c: ONE clock - the deadline told to phones and the server's own timer are the same length
    let duration = firstBid ? 10000 + TURN_CLOCK_MS : TURN_CLOCK_MS;
    // v117: when no phone is open the SERVER plays like a person: an empty (bot) chair thinks 2-8 seconds,
    // and a player who is away keeps his full 15 seconds for 2 card turns, then the server plays his chair in 2-8 seconds too
    if (!this.seats.some((x) => x && !x.away)) {
      const chair = this.seats[seat];
      const natural = 2000 + Math.floor(Math.random() * 6000);
      if (!chair) duration = natural;
      else if (this.awayTurns[seat] >= 2) duration = natural;
    }
    this.turnDeadline = Date.now() + duration;
    this.turnClock = setTimeout(() => this.clockFired(seat, phase), duration);
  }

  clockFired(seat: number, phase: string) {
    this.turnClock = null;
    if (this.turnSeat !== seat || this.phase !== phase) return;
    const nobodyHere = !this.seats.some((x) => x && !x.away);
    const humans = this.seats.some((x) => x && !x.left);
    if (!nobodyHere || !humans) return; // a phone is open: its AI plays as before
    this.serverMove(seat);
  }

  // v20b: the last phone just closed (pause / call / app closed). The turn keeps its ORIGINAL deadline.
  // (Before this fix the clock was restarted here, so every pause gave a brand new 15 seconds.)
  keepClockForServer() {
    if (this.turnSeat < 0 || this.closeTimer) return;
    if (this.turnDeadline <= 0) { this.restartClock(); return; } // no turn was running yet
    if (this.turnClock) { clearTimeout(this.turnClock); this.turnClock = null; }
    const seat = this.turnSeat, phase = this.phase;
    const wait = Math.max(500, this.turnDeadline - Date.now());
    console.log(`[v20d CLOCK KEPT] Room ${this.tableCode}: last phone closed, seat ${seat} keeps its old deadline (${wait} ms left)`);
    this.turnClock = setTimeout(() => this.clockFired(seat, phase), wait);
  }

  // the server makes the move for this chair and tells every phone (saved for anyone who comes back)
  serverMove(seat: number) {
    let m: any = null;
    if (this.phase === "bidding") m = { k: "bid", s: seat, v: String(this.botBid(this.hands[seat])) };
    else if (this.phase === "playing") { const c = this.botCard(this.hands[seat]); if (c) m = { k: "card", s: seat, v: c }; }
    if (!m) return;
    const awayChair = this.seats[seat];
    if (awayChair && m.k === "card") this.awayTurns[seat]++; // v117: one more full chance used up
    console.log(`[v14 SERVER AI] Room ${this.tableCode}: ${m.k} ${m.v} for seat ${seat} (no phone open)`);
    this.roundLog.push(m);
    try { this.broadcast("net", m); } catch (e) {}
    this.watch(m); // updates the server copy and starts the next clock
  }

  botBid(h: string[]): number {
    let n = 0; const sp = h.filter((c) => suitOf(c) === "s").length;
    for (const c of h) { const r = rankOf(c); if (r === 12) n++; else if (r === 11 && h.filter((x) => suitOf(x) === suitOf(c)).length >= 2) n++; }
    n += Math.max(0, sp - 3);
    return Math.max(1, Math.min(13, n));
  }

  legal(h: string[]): string[] {
    if (this.trick.length > 0) { const f = h.filter((c) => suitOf(c) === suitOf(this.trick[0].c)); return f.length ? f : h.slice(); }
    const ns = h.filter((c) => suitOf(c) !== "s");
    return this.spadesBroken || ns.length === 0 ? h.slice() : ns;
  }

  botCard(h: string[]): string | null {
    const L = this.legal(h); if (!L.length) return null;
    const low = (a: string[]) => a.slice().sort((x, y) => rankOf(x) - rankOf(y))[0];
    if (this.trick.length === 0) return low(L);
    let w = this.trick[0];
    for (const t of this.trick) if ((suitOf(t.c) === "s" && suitOf(w.c) !== "s") || (suitOf(t.c) === suitOf(w.c) && rankOf(t.c) > rankOf(w.c))) w = t;
    const beats = (c: string) => (suitOf(c) === "s" && suitOf(w.c) !== "s") || (suitOf(c) === suitOf(w.c) && rankOf(c) > rankOf(w.c));
    const win = L.filter(beats);
    return win.length ? low(win) : low(L);
  }

  // ---- match score kept on the server ----
  readScores(st?: string) {
    if (!st) return; const v = st.split(",").map((x) => parseInt(x, 10));
    if (v.length < 13 || v.some((x) => isNaN(x))) return;
    this.handNo = Math.max(1, v[0]); this.teamScore = [v[1], v[2]]; this.teamBags = [v[3], v[4]];
    this.soloScore = v.slice(5, 9); this.soloBags = v.slice(9, 13);
  }
  scoreState(): string {
    return [this.handNo, ...this.teamScore, ...this.teamBags, ...this.soloScore, ...this.soloBags].join(",");
  }
  scoreOne(bid: number, won: number, blind = false): [number, number] {
    const m = blind ? 2 : 1; // blind nil +-200, blind bid double points
    if (bid === 0) return [won === 0 ? 100 * m : -100 * m, won];
    return won >= bid ? [bid * 10 * m + (won - bid), won - bid] : [-bid * 10 * m, 0];
  }
  afterHand() {
    if (this.partners) {
      for (let t = 0; t < 2; t++) {
        const a = t, b = t + 2; let pts = 0, bags = 0;
        for (const x of [a, b]) if (this.bids[x] === 0) { const r = this.scoreOne(0, this.tricksWon[x], this.blind[x] === "N"); pts += r[0]; bags += r[1]; }
        const tb = (this.bids[a] > 0 ? this.bids[a] : 0) + (this.bids[b] > 0 ? this.bids[b] : 0);
        const tw = (this.bids[a] > 0 ? this.tricksWon[a] : 0) + (this.bids[b] > 0 ? this.tricksWon[b] : 0);
        const tblind = (this.bids[a] > 0 && this.blind[a] !== "" && this.blind[a] !== "N") || (this.bids[b] > 0 && this.blind[b] !== "" && this.blind[b] !== "N");
        if (tb > 0) { const r = this.scoreOne(tb, tw, tblind); pts += r[0]; bags += r[1]; }
        this.teamScore[t] += pts; this.teamBags[t] += bags;
        if (this.teamBags[t] >= 10) { this.teamBags[t] -= 10; this.teamScore[t] -= 100; }
      }
    } else {
      for (let x = 0; x < 4; x++) {
        const r = this.scoreOne(Math.max(0, this.bids[x]), this.tricksWon[x], this.blind[x] !== "");
        this.soloScore[x] += r[0]; this.soloBags[x] += r[1];
        if (this.soloBags[x] >= 10) { this.soloBags[x] -= 10; this.soloScore[x] -= 100; }
      }
    }
    const best = Math.max(...(this.partners ? this.teamScore : this.soloScore));
    console.log(`[v17 SCORE] Room ${this.tableCode} hand ${this.handNo}: ${this.partners ? this.teamScore.join("/") : this.soloScore.join("/")} (target ${this.targetScore})`);
    const nobodyHere = !this.seats.some((x) => x && !x.away);
    if (best >= this.targetScore) {
      if (nobodyHere) { this.closeTable("match finished - target reached"); return; }
      // a phone is open: its winner screen sends match_over; close anyway if it never comes
      if (!this.idleTimer) this.idleTimer = setTimeout(() => this.closeTable("match finished"), 60 * 1000);
      return;
    }
    this.handNo++;
    if (nobodyHere) { setTimeout(() => { if (this.phase === "idle" && !this.closeTimer && !this.seats.some((x) => x && !x.away)) this.serverDeal(); }, 5000); return; }
    // a phone is open and will deal; if no deal arrives within 90s the table is stuck -> close it
    if (!this.idleTimer) this.idleTimer = setTimeout(() => { if (this.phase === "idle") this.closeTable("no new deal after the hand"); }, 90 * 1000);
  }
  serverDeal() {
    const d = (this.dealer + 1) % 4; const seed = 1 + Math.floor(Math.random() * 2147483646);
    const m = { k: "deal", s: d, v: seed + ";" + this.scoreState() };
    console.log(`[v17 SERVER DEAL] Room ${this.tableCode}: hand ${this.handNo} (no phone open)`);
    this.lastDeal = m; this.roundLog = [m];
    try { this.broadcast("net", m); } catch (e) {}
    this.watch(m);
  }

  closeTable(why: string) {
    console.log(`[TABLE CLOSED] Room ${this.tableCode}: ${why}`);
    this.releaseLocks(); // everyone from this table may play elsewhere now
    try { this.broadcast("table_closed", { why }); } catch (e) {}
    this.disconnect();
  }

  onDispose() {
    this.releaseLocks();
    if (TABLE_CODES.get(this.tableCode) === this.roomId) TABLE_CODES.delete(this.tableCode); // v19
    if (this.closeTimer) clearTimeout(this.closeTimer);
    if (this.emptyTimer) clearTimeout(this.emptyTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.turnClock) clearTimeout(this.turnClock);
    console.log(`[ROOM DISPOSED] Room ${this.tableCode} (${this.roomId}) closed.`);
  }
}
