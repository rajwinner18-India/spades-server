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
}

const AWAY_TABLE_LIMIT_MS = 30 * 60 * 1000;   // v7: everyone away for 30 minutes -> table closes
const AFTER_WINNER_CLOSE_MS = 20 * 1000;      // v10: table vanishes 20s after the winner celebration

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
    if (!rejoined && this.closeTimer) throw new Error("TABLE FINISHED"); // v10: finished table takes no new players

    if (rejoined) {
      const seat = this.seats[assignedSeat]!;
      seat.sessionId = client.sessionId;
      seat.uid = uid; // v9: remember his newest id
      seat.away = false;
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

    // v8: only LEAVE TABLE / log out (or the finished match) frees the chair - never a closed app
    if (onPurpose || matchFinished) {
      console.log(`[PLAYER LEFT] Seat ${seatIdx} (${p.name}) left room ${this.tableCode}`);
      this.seats[seatIdx] = null;
      this.broadcast("seat_vacated", { seatIndex: seatIdx });
    } else {
      // v7: call / app closed / network drop -> keep the chair, AI plays it
      console.log(`[PLAYER AWAY] Seat ${seatIdx} (${p.name}) - chair kept, AI plays in room ${this.tableCode}`);
      p.away = true;
    }
    this.sendRoster();

    const anyoneHere = this.seats.some((s) => s && !s.away);
    const anyoneKept = this.seats.some((s) => s && s.away);
    if (!anyoneHere && !anyoneKept) this.closeTable("everyone left");
    else if (!anyoneHere && !this.emptyTimer)
      this.emptyTimer = setTimeout(() => this.closeTable("everyone away too long"), AWAY_TABLE_LIMIT_MS);
  }

  closeTable(why: string) {
    console.log(`[TABLE CLOSED] Room ${this.tableCode}: ${why}`);
    try { this.broadcast("table_closed", { why }); } catch (e) {}
    this.disconnect();
  }

  onDispose() {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    if (this.emptyTimer) clearTimeout(this.emptyTimer);
    console.log(`[ROOM DISPOSED] Room ${this.tableCode} (${this.roomId}) closed.`);
  }
} 
