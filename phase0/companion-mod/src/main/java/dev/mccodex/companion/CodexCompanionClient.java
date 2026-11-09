package dev.mccodex.companion;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.message.v1.ClientSendMessageEvents;
import net.minecraft.client.Minecraft;
import net.minecraft.network.chat.Component;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public final class CodexCompanionClient implements ClientModInitializer {
	private static final Logger LOGGER = LoggerFactory.getLogger("minecraft-codex-companion");

	@Override
	public void onInitializeClient() {
		LOGGER.info("Minecraft Codex Companion Phase 0 initialized");
		ClientSendMessageEvents.ALLOW_CHAT.register(message -> {
			var command = ChatCommandInterceptor.parse(message);
			if (command.isEmpty()) {
				return true;
			}

			ChatCommand parsed = command.orElseThrow();
			LOGGER.info("Intercepted local {} command for Phase 0", parsed.kind());
			Minecraft.getInstance().execute(() -> Minecraft.getInstance().gui.getChat().addMessage(
					Component.literal("[Codex Phase 0] Intercepted: " + parsed.text())
			));
			return false;
		});
	}
}
