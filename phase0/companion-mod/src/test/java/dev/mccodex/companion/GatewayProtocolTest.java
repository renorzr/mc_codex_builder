package dev.mccodex.companion;

import com.google.gson.JsonParser;
import java.net.URI;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

final class GatewayProtocolTest {
	@Test
	void emitsVersionedEnvelopeWithoutCredentials() {
		var payload = GatewayProtocol.worldPayload("test-world");
		payload.addProperty("text", "@codex 你好\n\"test\"");
		var message = GatewayProtocol.parse(GatewayProtocol.message("chat.command", payload));
		assertEquals("chat.command", message.get("type").getAsString());
		assertNotNull(UUID.fromString(message.get("messageId").getAsString()));
		assertEquals("@codex 你好\n\"test\"", message.getAsJsonObject("payload").get("text").getAsString());
		assertFalse(message.toString().contains("token"));
	}

	@Test
	void rejectsWrongVersionAndMalformedMessages() {
		assertThrows(RuntimeException.class, () -> GatewayProtocol.parse("{\"protocolVersion\":2,\"type\":\"ping\",\"payload\":{}}"));
		assertThrows(RuntimeException.class, () -> GatewayProtocol.parse("{broken"));
		assertThrows(RuntimeException.class, () -> GatewayProtocol.parse("[]"));
	}

	@Test
	void acceptsOnlyLoopbackUrlAndValidToken() {
		String token = "x".repeat(32);
		assertNotNull(new GatewayConfig(URI.create("ws://127.0.0.1:25600/ws"), token));
		for (String url : new String[]{"ws://example.com:25600/ws", "ws://127.0.0.1:25600/ws?token=x", "wss://127.0.0.1:25600/ws", "ws://user@127.0.0.1:25600/ws"}) {
			assertThrows(IllegalArgumentException.class, () -> new GatewayConfig(URI.create(url), token));
		}
		assertThrows(IllegalArgumentException.class, () -> new GatewayConfig(URI.create("ws://127.0.0.1:25600/ws"), "short"));
	}
}
