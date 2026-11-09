package dev.mccodex.companion;

import net.fabricmc.fabric.api.client.message.v1.ClientSendMessageEvents;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

final class FabricChatEventContractTest {
	@Test
	void allowChatFalseCancelsOnlyCodexMessages() {
		ClientSendMessageEvents.ALLOW_CHAT.register(message -> ChatCommandInterceptor.parse(message).isEmpty());

		assertFalse(ClientSendMessageEvents.ALLOW_CHAT.invoker().allowSendChatMessage("@codex inspect"));
		assertTrue(ClientSendMessageEvents.ALLOW_CHAT.invoker().allowSendChatMessage("ordinary chat"));
	}
}
