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
import { MyRoom } from "./rooms/MyRoom.js";

const server = defineServer({

  /**
   * v4: Quick Match fix - removed tableCode from filter so Solo players share one table
   * - SOLO players only meet SOLO players, PARTNERS only meet PARTNERS
   * - CLASSIC PRO only meets CLASSIC PRO, BEAT & LAUGH only meets BEAT & LAUGH
   * - Private CREATE TABLE tables (with a 4-digit code) are never joined by Quick Match
   */
  rooms: {
    my_room: defineRoom(MyRoom).filterBy(["mode", "format"]),
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
      const rooms = await matchMaker.query({ name: "my_room" });
      const r = rooms.find((x: any) => x.metadata && x.metadata.tableCode === req.params.code);
      if (!r) return res.json({ found: false });
      res.json({ found: true, roomId: r.roomId, full: r.clients >= r.maxClients, ...r.metadata });
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