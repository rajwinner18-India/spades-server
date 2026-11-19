// v14: AWAY vs LEFT + SERVER PLAYS - when NO phone is open at the table (e.g. the only human closed the app),
//      the server itself now bids and plays legal cards for every chair after the 12-second clock, so the hand
//      keeps moving. Those moves are saved, so the returning player sees the table as it is now and gets
//      "AI PLAYING FOR YOU - I'M BACK". AWAY (call/app closed) = chair kept, he can come back and take over.
//      LEFT (LEAVE TABLE) = AI plays that chair to the end, no taking back. The AI only plays while at least one
//      human (away counts, left does not) belongs to the table; with no humans the table closes at once.
//      The next deal still comes from a phone (scores live on the phones). Rest = v13.
// v13: TABLE LOCK ALSO BY NAME - the same refusal now works even when an app build sends no login id,
//      because a player's name is unique and his chair is locked under his name as well. Everything else = v12.
// v12: TABLE LOCK (Zynga rules) - LEAVE TABLE no longer frees the player: the AI plays his chair to the end and
//      his player id stays locked to this table, so he cannot join or create any other table while at least one
//      human is still seated here. When the LAST human presses LEAVE TABLE the table vanishes at once and every
//      player from it is free again. A locked player can always come back into his own chair. Rest = v11.
// v11: ALWAYS-ON TABLE STEP 1 - the server now keeps its OWN copy of the live hand (same shuffle as the phones),
//      follows every bid and card, knows whose turn it is and runs a 12-second clock for every chair.
//      Step 1 only WATCHES and writes to the server log - it never plays or changes anything. Rest = v10.
// v10: UNIQUE NAME + LOBBY AFTER MATCH - name match ignores capital letters; after the winner screen the table
//      closes in 20s and can never restart (no PLAY AGAIN); a finished table accepts no new player.
// v9: ONE CHAIR PER PLAYER + LIVE TABLE ON RETURN - a returning player is matched by login id OR by his name,
//     so he always gets his OWN chair back (never a second chair with the same name). On return mid-hand he gets
//     the live hand replayed fast (his real cards + every card already played) and sees the table as it is NOW.
// v8: CHAIR NEVER LOST - closing the app / a call / lost network NEVER frees the chair or removes the name,
//     before OR during the game. Only LEAVE TABLE / log out frees it. A returning player keeps his name on every screen.
// v7: KEEP MY SEAT - a player who gets a call / closes the app keeps his chair (AI plays it) and is seated back
//     in the SAME live table when he returns; Leave Table frees the chair; the table closes itself after the
//     winner celebration (unless the players press PLAY AGAIN). Rest = v6.
// v6: CALM SPECTATOR - no replay to late joiners; the bot keeps their chair until the next deal (rest = v5)
// MyRoom v5 - LATE JOIN (rest = v4)   MyRoom v4 - SAME PLAYER COUNT (rest = v3)   MyRoom v3 - LIVE TABLE moves
import { Room, Client, CloseCode } from "colyseus";
import { MyRoomState } from "./schema/MyRoomState.js";

interface PlayerSeat {
  sessionId: string;
  seatIndex: number; // 0: Rex/South, 1: Carlos/West, 2: Jack/North, 3: Viktor/East
  name: string;
  isBot: boolean;
  avatarUrl?: string;
  coins: number;
  uid: string;   // v7: the player's login id (same id = same chair when he comes back)
  away: boolean; // v7: phone call / app closed - AI plays his chair until he returns
  left?: boolean; // v12: pressed LEAVE TABLE - AI plays his chair to the end, he is still locked to this table
}

const AWAY_TABLE_LIMIT_MS = 30 * 60 * 1000;   // v7: everyone away for 30 minutes -> table closes
const AFTER_WINNER_CLOSE_MS = 20 * 1000;      // v10: table vanishes 20s after the winner celebration


// ---- v11: exact copy of the phones' System.Random(seed), so the server deals the very same cards ----
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
// v12: one live table per player id across the whole server: uid -> room that owns him
const TABLE_LOCKS = new Map<string, { roomId: string; code: string }>();
const TURN_CLOCK_MS = Number(process.env.SAM_TURN_MS) || 12 * 1000; // v11: same 12 seconds the phones use

export class MyRoom extends Room<{ state: MyRoomState }> {
  maxClients = 4;
  autoDispose = false; // v7: an empty-looking table (everyone on a call) must stay alive
  state = new MyRoomState();

  tableMode: "classic_pro" | "beat_and_laugh" = "classic_pro";
  tableCode: string = "0000";
  targetScore: number = 200;
  stakeCoins: number = 500;

  seats: (PlayerSeat | null)[] = [null, null, null, null];

  lastDeal: any = null;
  roundLog: any[] = [];

  // v11: the server's own view of the live hand (watch only in step 1)
  hands: string[][] = [[], [], [], []];
  bids: number[] = [-1, -1, -1, -1];
  tricksWon: number[] = [0, 0, 0, 0];
  trick: { s: number; c: string }[] = [];
  turnSeat = -1;
  phase: "idle" | "bidding" | "playing" = "idle";
  turnClock: any = null;
  spadesBroken = false; // v14

  leavingOnPurpose = new Set<string>(); // v7: sessions that pressed LEAVE TABLE / log out
  closeTimer: any = null;               // v7: winner celebration -> close
  emptyTimer: any = null;               // v7: everyone away -> close

  // "Rex|Carlos||" - empty = free chair; v7: "~Name" = chair kept for a player who is away
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

    console.log(`[SPADES ROOM CREATED] ID: ${this.roomId} | Code: ${this.tableCode} | Mode: ${this.tableMode} | Stake: ${this.stakeCoins}`);

    this.onMessage("play_card", (client, message) => {
      this.broadcast("card_played", { sessionId: client.sessionId, card: message.card, seatIndex: message.seatIndex });
    });
    this.onMessage("make_bid", (client, message) => {
      this.broadcast("bid_made", { sessionId: client.sessionId, bid: message.bid, seatIndex: message.seatIndex });
    });

    this.onMessage("net", (client, message) => {
      if (message && message.k === "deal") {
        this.lastDeal = message; this.roundLog = [];
        if (this.closeTimer) return; // v10: match finished - no new game on this table
      }
      if (message && message.k !== "tq") this.roundLog.push(message);
      try { this.watch(message); } catch (e) { console.log(`[v11 WATCH] skipped: ${e}`); } // v11: never breaks the relay
      this.broadcast("net", message, { except: client });
    });

    // v7: player pressed LEAVE TABLE or logged out -> his chair is really freed
    this.onMessage("leave_seat", (client) => {
      this.leavingOnPurpose.add(client.sessionId);
    });

    // v7: winner celebration started -> table vanishes after it (cancelled if a new deal arrives)
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
    const uid = String(options.uid || "") || "dev_" + client.sessionId; // v8: every chair has an owner id
    const playerName = options.name || `Player_${client.sessionId.substring(0, 4)}`;

    // v7: same login id already owns a chair here -> sit him back in it
    let assignedSeat = uid ? this.seats.findIndex((s) => s !== null && s.uid === uid) : -1;
    // v9: id changed (new guest session / new connection) -> same name already owns a chair here = it is him
    // v10: same name in any letter case = same player (user names are unique)
    const key = String(playerName).trim().toUpperCase();
    if (assignedSeat < 0 && options.name)
      assignedSeat = this.seats.findIndex((s) => s !== null && String(s.name).trim().toUpperCase() === key);
    const rejoined = assignedSeat >= 0;
    if (!rejoined && this.closeTimer) throw new Error("TABLE FINISHED");
    // v12: still locked to another live table -> refused (he can only go back to that one)
    // v13: look him up by login id AND by his name, so the rule holds even if an app build sends no id
    const lock = TABLE_LOCKS.get(uid) || (key ? TABLE_LOCKS.get("NAME:" + key) : undefined);
    if (!rejoined && lock && lock.roomId !== this.roomId) {
      console.log(`[v12 LOCK] ${playerName} refused in ${this.tableCode} - still seated at table ${lock.code}`);
      throw new Error("ACTIVE TABLE " + lock.code);
    } // v10: finished table takes no new players

    if (rejoined) {
      const seat = this.seats[assignedSeat]!;
      seat.sessionId = client.sessionId;
      seat.uid = uid; // v9: remember his newest id
      if (seat.uid !== uid && TABLE_LOCKS.get(seat.uid)?.roomId === this.roomId) TABLE_LOCKS.delete(seat.uid);
      const oldName = String(seat.name).trim().toUpperCase(); // v13: his chair may be locked under his previous name
      if (oldName && oldName !== key && TABLE_LOCKS.get("NAME:" + oldName)?.roomId === this.roomId) TABLE_LOCKS.delete("NAME:" + oldName);
      seat.away = false;
      seat.left = false; // v12: back in his own chair
      seat.name = playerName;
      console.log(`[PLAYER BACK] ${playerName} -> Seat ${assignedSeat} in Room ${this.tableCode}`);
    } else {
      for (let i = 0; i < 4; i++) if (!this.seats[i]) { assignedSeat = i; break; }
      if (assignedSeat < 0) throw new Error("TABLE FULL"); // v7: chairs kept for away players are never given away
      this.seats[assignedSeat] = {
        sessionId: client.sessionId, seatIndex: assignedSeat, name: playerName, isBot: false,
        avatarUrl: options.avatarUrl || "", coins: Number(options.coins) || 10000, uid, away: false,
      };
      console.log(`[PLAYER SEATED] ${playerName} -> Seat ${assignedSeat} (Session: ${client.sessionId}) in Room ${this.tableCode}`);
    }
    if (this.emptyTimer) { clearTimeout(this.emptyTimer); this.emptyTimer = null; }
    TABLE_LOCKS.set(uid, { roomId: this.roomId, code: this.tableCode }); // v12
    if (key) TABLE_LOCKS.set("NAME:" + key, { roomId: this.roomId, code: this.tableCode }); // v13: lock his name too

    client.send("welcome_table", {
      seatIndex: assignedSeat,
      tableCode: this.tableCode,
      tableMode: this.tableMode,
      targetScore: this.targetScore,
      stakeCoins: this.stakeCoins,
      names: this.roster(),
      rejoined,
    });

    // hand already running -> the AI keeps this chair until the next deal, then he plays his own cards
    if (this.lastDeal && !this.closeTimer) this.broadcast("net", { k: "dl", s: assignedSeat, v: rejoined ? "2" : "1" });
    // v9: returning player -> replay the live hand to HIM only, so he sees his current cards and the live trick
    if (rejoined && this.lastDeal && !this.closeTimer) {
      client.send("replay", this.lastDeal);
      for (const m of this.roundLog) if (m !== this.lastDeal) client.send("replay", m);
    } // v8: "2" = returning player, his name stays

    this.broadcast("seat_updated", { seatIndex: assignedSeat, player: this.seats[assignedSeat] });
    this.sendRoster();
  }

  onLeave(client: Client, code: CloseCode) {
    const seatIdx = this.seats.findIndex((s) => s && s.sessionId === client.sessionId);
    if (seatIdx < 0) return;
    const p = this.seats[seatIdx]!;
    const onPurpose = this.leavingOnPurpose.delete(client.sessionId);
    const matchFinished = this.closeTimer !== null;

    if (matchFinished) {
      // v12: match over -> chair and player are both free
      console.log(`[PLAYER LEFT] Seat ${seatIdx} (${p.name}) left finished room ${this.tableCode}`);
      if (TABLE_LOCKS.get(p.uid)?.roomId === this.roomId) TABLE_LOCKS.delete(p.uid);
      const fn = String(p.name).trim().toUpperCase(); // v13: release the name lock as well
      if (fn && TABLE_LOCKS.get("NAME:" + fn)?.roomId === this.roomId) TABLE_LOCKS.delete("NAME:" + fn);
      this.seats[seatIdx] = null;
      this.broadcast("seat_vacated", { seatIndex: seatIdx });
    } else if (onPurpose) {
      // v12: LEAVE TABLE -> AI plays his chair to the end; he stays locked to this table
      console.log(`[v12 LEFT TABLE] Seat ${seatIdx} (${p.name}) - AI plays to the end, player locked to ${this.tableCode}`);
      p.away = true; p.left = true;
    } else {
      // v7: call / app closed / network drop -> keep the chair, AI plays it
      console.log(`[PLAYER AWAY] Seat ${seatIdx} (${p.name}) - chair kept, AI plays in room ${this.tableCode}`);
      p.away = true;
    }
    this.sendRoster();
    if (!this.seats.some((s) => s && !s.away)) this.restartClock(); // v14: last phone closed -> the server clock takes over

    // v12: humans = everyone seated who did NOT press LEAVE TABLE (a call / closed app still counts as a human)
    const humansLeft = this.seats.some((s) => s && !s.left);
    const anyoneConnected = this.seats.some((s) => s && !s.away);
    if (!humansLeft) this.closeTable("every human left the table");
    else if (!anyoneConnected && !this.emptyTimer)
      this.emptyTimer = setTimeout(() => this.closeTable("everyone away too long"), AWAY_TABLE_LIMIT_MS);
  }

  // v12: free every player id that this table was holding
  releaseLocks() {
    for (const [uid, l] of TABLE_LOCKS) if (l.roomId === this.roomId) TABLE_LOCKS.delete(uid);
  }

  // ---- v11: follow the live hand (watch only - nothing is sent to the phones) ----
  watch(m: any) {
    if (!m || typeof m.k !== "string") return;
    const s = Number(m.s);
    if (m.k === "deal") {
      const seed = parseInt(String(m.v || "").split(";")[0], 10);
      if (isNaN(seed) || isNaN(s)) return;
      const deck = shuffledDeck(new NetRandom(seed));
      this.hands = [[], [], [], []];
      for (let i = 0; i < 52; i++) this.hands[(s + 1 + i) % 4].push(deck[i]);
      this.bids = [-1, -1, -1, -1]; this.tricksWon = [0, 0, 0, 0]; this.trick = []; this.spadesBroken = false;
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
          console.log(`[v11 HAND END] Room ${this.tableCode} tricks ${this.tricksWon.join("/")}`); }
      }
    } else return;
    this.restartClock();
  }

  restartClock() {
    if (this.turnClock) { clearTimeout(this.turnClock); this.turnClock = null; }
    if (this.turnSeat < 0 || this.closeTimer) return;
    const seat = this.turnSeat, phase = this.phase;
    this.turnClock = setTimeout(() => {
      this.turnClock = null;
      if (this.turnSeat !== seat || this.phase !== phase) return;
      const nobodyHere = !this.seats.some((x) => x && !x.away);
      const humans = this.seats.some((x) => x && !x.left);
      if (!nobodyHere || !humans) return; // a phone is open: its AI plays as before
      this.serverMove(seat);
    }, TURN_CLOCK_MS);
  }

  // v14: the server makes the move for this chair and tells every phone (saved for anyone who comes back)
  serverMove(seat: number) {
    let m: any = null;
    if (this.phase === "bidding") m = { k: "bid", s: seat, v: String(this.botBid(this.hands[seat])) };
    else if (this.phase === "playing") { const c = this.botCard(this.hands[seat]); if (c) m = { k: "card", s: seat, v: c }; }
    if (!m) return;
    console.log(`[v14 SERVER AI] Room ${this.tableCode}: ${m.k} ${m.v} for seat ${seat} (no phone open)`);
    this.roundLog.push(m);
    try { this.broadcast("net", m); } catch (e) {}
    this.watch(m); // updates the server copy and starts the next 12-second clock
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

  closeTable(why: string) {
    console.log(`[TABLE CLOSED] Room ${this.tableCode}: ${why}`);
    this.releaseLocks(); // v12: everyone from this table may play elsewhere now
    try { this.broadcast("table_closed", { why }); } catch (e) {}
    this.disconnect();
  }

  onDispose() {
    this.releaseLocks(); // v12
    if (this.closeTimer) clearTimeout(this.closeTimer);
    if (this.emptyTimer) clearTimeout(this.emptyTimer);
    if (this.turnClock) clearTimeout(this.turnClock);
    console.log(`[ROOM DISPOSED] Room ${this.tableCode} (${this.roomId}) closed.`);
  }
}
