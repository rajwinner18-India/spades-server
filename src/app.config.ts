import {
  defineServer,
  defineRoom,
  monitor,
  playground,
  createRouter,
  createEndpoint,
  matchMaker,
} from "colyseus";

/**
 * Import your Room files
 */
import { MyRoom, TABLE_CODES } from "./rooms/MyRoom.js";

const server = defineServer({

  /**
   * v5: SAFE MATCHING
   * - SOLO players only meet SOLO players, PARTNERS only meet PARTNERS
   * - CLASSIC PRO only meets CLASSIC PRO
   * - the same entry stake and target score only (nobody is seated at a table with a different stake)
   * - tables made with a 4-digit code are PRIVATE (see MyRoom.ts), so Quick Match never joins them
   */
  rooms: {
    my_room: defineRoom(MyRoom).filterBy(["mode", "format", "stakeCoins", "targetScore"]),
  },

  routes: createRouter({
    api_hello: createEndpoint("/api/hello", { method: "GET" }, async (ctx) => {
      return { message: "Hello World" };
    }),
  }),

  express: (app) => {

    app.get("/hi", (req, res) => {
      res.send("It's time to kick ass and chew bubblegum!");
    });

    // JOIN TABLE by 4-digit code: Unity asks "/find/1458" and gets the live table back
    app.get("/find/:code", async (req, res) => {
      try {
        const code = String(req.params.code);
        let rooms: any[] = await matchMaker.query({ name: "my_room" });
        let r = rooms.find((x: any) => x.metadata && x.metadata.tableCode === code);
        if (!r) {
          // private tables are found through the code list
          const roomId = TABLE_CODES.get(code);
          if (roomId) {
            rooms = await matchMaker.query({ roomId });
            r = rooms[0];
          }
        }
        if (!r) return res.json({ found: false });
        res.json({ found: true, roomId: r.roomId, full: r.clients >= r.maxClients, ...r.metadata });
      } catch (e) {
        console.log("[/find] error: " + e);
        res.json({ found: false });
      }
    });

    if (process.env.NODE_ENV !== "production") {
      app.use("/monitor", monitor());
    }

    if (process.env.NODE_ENV !== "production") {
      app.use("/", playground());
    }
  }
});

export default server;
