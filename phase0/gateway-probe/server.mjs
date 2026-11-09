import { WebSocketServer } from "ws";

const host = "127.0.0.1";
const port = Number(process.env.PHASE0_GATEWAY_PORT ?? 25600);
const token = process.env.PHASE0_GATEWAY_TOKEN;
if (!token) throw new Error("PHASE0_GATEWAY_TOKEN is required");

const server = new WebSocketServer({
  host,
  port,
  path: "/ws",
  verifyClient: ({ req }) => req.headers.authorization === "Bearer " + token,
});

server.on("connection", (socket) => {
  socket.send(JSON.stringify({ type: "gateway.hello", protocolVersion: 1 }));
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString("utf8"));
    socket.send(JSON.stringify({ type: "gateway.echo", payload: message }));
  });
});

server.on("listening", () => {
  console.log(JSON.stringify({ ready: true, url: "ws://" + host + ":" + port + "/ws" }));
});

process.on("SIGTERM", () => server.close());
