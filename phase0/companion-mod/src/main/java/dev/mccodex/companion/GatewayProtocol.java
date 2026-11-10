package dev.mccodex.companion;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.time.Instant;
import java.util.UUID;

public final class GatewayProtocol {
	public static final int MAX_MESSAGE_BYTES = 64 * 1024;
	private GatewayProtocol() {}

	public static String message(String type, JsonObject payload) {
		JsonObject message = new JsonObject();
		message.addProperty("protocolVersion", 1);
		message.addProperty("messageId", UUID.randomUUID().toString());
		message.addProperty("timestamp", Instant.now().toString());
		message.addProperty("type", type);
		message.add("payload", payload);
		return message.toString();
	}

	public static JsonObject worldPayload(String worldSessionId) {
		JsonObject payload = new JsonObject();
		payload.addProperty("worldSessionId", worldSessionId);
		return payload;
	}

	public static JsonObject parse(String text) {
		JsonObject message = JsonParser.parseString(text).getAsJsonObject();
		if (!message.has("protocolVersion") || !message.get("protocolVersion").getAsString().equals("1")
				|| !message.has("type") || !message.has("payload") || !message.get("payload").isJsonObject()) {
			throw new IllegalArgumentException("Invalid Gateway message");
		}
		return message;
	}

	public static String render(JsonObject message) {
		JsonObject payload = message.getAsJsonObject("payload");
		return switch (message.get("type").getAsString()) {
			case "gateway.hello" -> "[Codex] Gateway 已连接（" + payload.get("backend").getAsString() + "，"
					+ (payload.has("mode") && payload.get("mode").getAsString().equals("observe") ? "世界观察，只读" : "仅聊天") + "）。";
			case "chat.message" -> "[Codex] " + payload.get("text").getAsString();
			case "task.status" -> "[Codex] " + payload.getAsJsonObject("task").get("id").getAsString()
					+ " " + payload.getAsJsonObject("task").get("status").getAsString();
			case "task.failed" -> "[Codex] 任务失败：" + payload.getAsJsonObject("task").get("error").getAsString();
			case "command.error" -> "[Codex] " + payload.get("message").getAsString();
			default -> null;
		};
	}
}
