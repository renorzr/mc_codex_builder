package dev.mccodex.companion;

import java.util.Optional;

public final class ChatCommandInterceptor {
	private static final String TASK_PREFIX = "@codex";
	private static final String CONTROL_PREFIX = "!codex";

	private ChatCommandInterceptor() {
	}

	public static Optional<ChatCommand> parse(String message) {
		Optional<String> task = stripPrefix(message, TASK_PREFIX);
		if (task.isPresent()) {
			return task.map(text -> new ChatCommand(ChatCommand.Kind.TASK, text));
		}

		return stripPrefix(message, CONTROL_PREFIX)
				.map(text -> new ChatCommand(ChatCommand.Kind.CONTROL, text));
	}

	private static Optional<String> stripPrefix(String message, String prefix) {
		if (message == null || !message.regionMatches(true, 0, prefix, 0, prefix.length())) {
			return Optional.empty();
		}
		if (message.length() > prefix.length() && !Character.isWhitespace(message.charAt(prefix.length()))) {
			return Optional.empty();
		}
		return Optional.of(message.substring(prefix.length()).trim());
	}
}
