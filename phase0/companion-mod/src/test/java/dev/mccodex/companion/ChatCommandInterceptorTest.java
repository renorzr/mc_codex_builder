package dev.mccodex.companion;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

final class ChatCommandInterceptorTest {
	@Test
	void interceptsTaskPrefix() {
		ChatCommand command = ChatCommandInterceptor.parse("@codex build a tower").orElseThrow();
		assertEquals(ChatCommand.Kind.TASK, command.kind());
		assertEquals("build a tower", command.text());
	}

	@Test
	void interceptsControlPrefixCaseInsensitively() {
		ChatCommand command = ChatCommandInterceptor.parse("!CODEX status").orElseThrow();
		assertEquals(ChatCommand.Kind.CONTROL, command.kind());
		assertEquals("status", command.text());
	}

	@Test
	void leavesOrdinaryChatAlone() {
		assertTrue(ChatCommandInterceptor.parse("hello server").isEmpty());
		assertTrue(ChatCommandInterceptor.parse("@codextra").isEmpty());
	}
}
