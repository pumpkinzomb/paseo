// Fully local ACP peer: no network, credentials, model CLI, or filesystem writes.
const { createInterface } = require("node:readline");
const { randomUUID } = require("node:crypto");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const models = [
  { modelId: "core-one", name: "Core One" },
  { modelId: "core-two", name: "Core Two" },
];
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const reply = (result) => send({ jsonrpc: "2.0", id: request.id, result });
  switch (request.method) {
    case "initialize":
      reply({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
      break;
    case "session/new":
      reply({
        sessionId: randomUUID(),
        models: { currentModelId: "core-one", availableModels: models },
      });
      break;
    case "session/set_model":
      reply({});
      break;
    case "session/prompt":
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: request.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Local fixture acknowledged the conversation." },
          },
        },
      });
      reply({ stopReason: "end_turn" });
      break;
    default:
      reply({});
  }
});
