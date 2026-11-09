package dev.mccodex.companion;

public record ChatCommand(Kind kind, String text) {
	public enum Kind {
		TASK,
		CONTROL
	}
}
