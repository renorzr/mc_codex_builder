import readline from "node:readline";
import { appendFileSync } from "node:fs";
const logFile = process.argv[2];
let thread = "fixture-thread";
let nextTurn = 0;
const turns = new Map();
const send = message => process.stdout.write(JSON.stringify(message) + "\n");
const reply = (id, result) => send({ id, result });
const notify = (method, params) => send({ method, params });
const completed = (id, status = "completed") => notify("turn/completed", { threadId: thread, turn: { id, status, error: null } });
for await (const line of readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (logFile) appendFileSync(logFile, JSON.stringify(message) + "\n");
  const { id, method, params } = message;
  if (method === "initialize") reply(id, { userAgent: "fixture", codexHome: "/fixture" });
  else if (method === "config/read") reply(id, { config: { mcp_servers: { dangerous: { enabled: true } } } });
  else if (method === "thread/start") { thread = "fixture-thread-" + Date.now(); reply(id, { thread: { id: thread } }); }
  else if (method === "thread/resume") { thread = params.threadId; reply(id, { thread: { id: thread } }); }
  else if (method === "turn/start") {
    const text = params.input[0].text;
    const turn = "turn-" + ++nextTurn;
    if (text === "crash") { process.exit(17); }
    if (text === "malformed") { process.stdout.write("{bad-json\n"); continue; }
    if (text === "hang") continue;
    const finish = () => {
      notify("item/completed", { threadId: thread, turnId: turn, item: { id: "reply-" + turn, type: "agentMessage", text: "fixture: " + text } });
      completed(turn);
    };
    turns.set(turn, finish);
    if (text === "early") { finish(); reply(id, { turn: { id: turn } }); }
    else if (text === "slow-start") { setTimeout(() => reply(id, { turn: { id: turn } }), 100); }
    else {
      reply(id, { turn: { id: turn } });
      if (text === "approval") {
        send({ id: "approval-1", method: "item/commandExecution/requestApproval", params: { threadId: thread, turnId: turn } });
        send({ id: "approval-2", method: "item/fileChange/requestApproval", params: { threadId: thread, turnId: turn } });
        send({ id: "legacy-approval", method: "execCommandApproval", params: {} });
      }
      if (text !== "slow") setTimeout(finish, 10);
    }
  } else if (method === "turn/interrupt") { reply(id, {}); completed(params.turnId, "interrupted"); }
}
