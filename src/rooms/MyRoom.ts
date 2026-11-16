// v6: CALM SPECTATOR - no replay to late joiners; the bot keeps their chair until the next deal (rest = v5)
// MyRoom v5 - LATE JOIN: newcomer gets every move of the current hand (fast catch-up) and the bot keeps his chair until he takes over (rest = v4)
// MyRoom v4 - SAME PLAYER COUNT on every screen + late joiner gets the current deal (rest = v3)
// MyRoom v3 - LIVE TABLE moves passed between players (rest = v2)
import { Room, Client, CloseCode } from "colyseus";
import { MyRoomState } from "./schema/MyRoomState.js";

interface PlayerSeat {
  sessionId: string;
  seatIndex: number; // 0: Rex/South, 1: Carlos/West, 2: Jack/North, 3: Viktor/East
  name: string;
  isBot: boolean;
  avatarUrl?: string;
  coins: number;
}

export class MyRoom extends Room<{ state: MyRoomState }> {
  maxClients = 4;
  state = new MyRoomState();

  // Table metadata
  tableMode: "classic_pro" | "beat_and_laugh" = "classic_pro";
  tableCode: string = "0000";
  targetScore: number = 200;
  stakeCoins: number = 500;

  // 4 Seats
  seats: (PlayerSeat | null)[] = [null, null, null, null];

  // v4: last shuffle sent by the host, handed to anyone who sits down late
  lastDeal: any = null;
  // v5: every move of the current hand (deal first), replayed to a late joiner
  roundLog: any[] = [];

  // v4: simple seat list "Rex|Carlos||" - empty = free chair (easy for Unity to read)
  roster(): string {
    return this.seats.map((s) => (s ? (s.name || "Player").replace(/\|/g, " ") : "")).join("|");
  }
  sendRoster() {
    this.broadcast("roster", { names: this.roster() });
  }

  onCreate(options: any) {
    // Mode: "classic_pro" or "beat_and_laugh"
    if (options.mode === "beat_and_laugh" || options.mode === "classic_pro") {
      this.tableMode = options.mode;
    }

    // 4-digit Table Code (e.g. "1458" or random)
    if (options.tableCode && options.tableCode.length === 4) {
      this.tableCode = options.tableCode;
    } else {
      this.tableCode = Math.floor(1000 + Math.random() * 9000).toString();
    }

    if (options.targetScore) {
      this.targetScore = Number(options.targetScore) || 200;
    }
    if (options.stakeCoins) {
      this.stakeCoins = Number(options.stakeCoins) || 500;
    }

    // Set room metadata for matchmaking and lobby filtering
    this.setMetadata({
      tableMode: this.tableMode,
      tableCode: this.tableCode,
      targetScore: this.targetScore,
      stakeCoins: this.stakeCoins,
      format: options.format === "partners" ? "partners" : "solo",
    });

    console.log(`[SPADES ROOM CREATED] ID: ${this.roomId} | Code: ${this.tableCode} | Mode: ${this.tableMode} | Stake: ${this.stakeCoins}`);

    // Listen for card plays, bids, or emotes from Unity
    this.onMessage("play_card", (client, message) => {
      this.broadcast("card_played", {
        sessionId: client.sessionId,
        card: message.card,
        seatIndex: message.seatIndex,
      });
    });

    this.onMessage("make_bid", (client, message) => {
      this.broadcast("bid_made", {
        sessionId: client.sessionId,
        bid: message.bid,
        seatIndex: message.seatIndex,
      });
    });

    // v3: LIVE TABLE - pass each move (deal / bid / card) to the other players at this table
    this.onMessage("net", (client, message) => {
      if (message && message.k === "deal") { this.lastDeal = message; this.roundLog = []; } // v4 + v5
      if (message && message.k !== "tq") this.roundLog.push(message); // v5
      this.broadcast("net", message, { except: client });
    });

    this.onMessage("taunt", (client, message) => {
      this.broadcast("player_taunt", {
        sessionId: client.sessionId,
        targetSeat: message.targetSeat,
        action: message.action,
      });
    });
  }

  onJoin(client: Client, options: any) {
    // Find first free seat (0..3)
    let assignedSeat = -1;
    for (let i = 0; i < 4; i++) {
      if (!this.seats[i]) {
        assignedSeat = i;
        break;
      }
    }

    const playerName = options.name || `Player_${client.sessionId.substring(0, 4)}`;
    const playerCoins = Number(options.coins) || 10000;

    const newPlayer: PlayerSeat = {
      sessionId: client.sessionId,
      seatIndex: assignedSeat,
      name: playerName,
      isBot: false,
      avatarUrl: options.avatarUrl || "",
      coins: playerCoins,
    };

    if (assignedSeat >= 0) {
      this.seats[assignedSeat] = newPlayer;
    }

    console.log(`[PLAYER SEATED] ${playerName} -> Seat ${assignedSeat} (Session: ${client.sessionId}) in Room ${this.tableCode}`);

    // Send table setup to the joining player
    client.send("welcome_table", {
      seatIndex: assignedSeat,
      tableCode: this.tableCode,
      tableMode: this.tableMode,
      targetScore: this.targetScore,
      stakeCoins: this.stakeCoins,
      names: this.roster(), // v4
    });

    // v4: if the host already shuffled, give the newcomer the same cards
    // v5: hand already running -> replay the whole hand to the newcomer, and tell every screen the bot keeps that chair for now
    if (this.lastDeal && assignedSeat >= 0) {
      this.broadcast("net", { k: "dl", s: assignedSeat, v: "1" });
    }

    // Notify all players in room about the new player
    this.broadcast("seat_updated", {
      seatIndex: assignedSeat,
      player: newPlayer,
    });
    this.sendRoster(); // v4: everyone now shows the same count
  }

  onLeave(client: Client, code: CloseCode) {
    const seatIdx = this.seats.findIndex((s) => s && s.sessionId === client.sessionId);
    if (seatIdx >= 0) {
      const leavingPlayer = this.seats[seatIdx];
      console.log(`[PLAYER LEFT] Seat ${seatIdx} (${leavingPlayer?.name}) left room ${this.tableCode}`);
      this.seats[seatIdx] = null;

      this.broadcast("seat_vacated", {
        seatIndex: seatIdx,
      });
      this.sendRoster(); // v4
    }
  }

  onDispose() {
    console.log(`[ROOM DISPOSED] Room ${this.tableCode} (${this.roomId}) closed.`);
  }
}