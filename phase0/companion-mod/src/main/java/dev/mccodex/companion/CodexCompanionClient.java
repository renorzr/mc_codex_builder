package dev.mccodex.companion;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.message.v1.ClientSendMessageEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.Minecraft;
import net.minecraft.network.chat.Component;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import java.util.UUID;

public final class CodexCompanionClient implements ClientModInitializer {
	private static final Logger LOGGER = LoggerFactory.getLogger("minecraft-codex-companion");
	private GatewayConnection gateway;
	private long worldGeneration;

	@Override
	public void onInitializeClient() {
		LOGGER.info("Minecraft Codex Companion initialized");
		var configFile = FabricLoader.getInstance().getConfigDir().resolve("minecraft-codex.json");
		ClientPlayConnectionEvents.JOIN.register((handler, sender, client) -> {
			long generation = ++worldGeneration;
			if (gateway != null) gateway.close();
			try {
				gateway = new GatewayConnection(GatewayConfig.load(configFile), message -> display(message, generation));
				gateway.setWorld(UUID.randomUUID().toString());
			} catch (Exception error) {
				gateway = null;
				display("[Codex] 请配置 config/minecraft-codex.json 的 Gateway 地址和 token。", generation);
			}
		});
		ClientPlayConnectionEvents.DISCONNECT.register((handler, client) -> {
			worldGeneration++;
			if (gateway != null) { gateway.close(); gateway = null; }
		});
		ClientLifecycleEvents.CLIENT_STOPPING.register(client -> { worldGeneration++; if (gateway != null) gateway.close(); });
		ClientSendMessageEvents.ALLOW_CHAT.register(message -> {
			var command = ChatCommandInterceptor.parse(message);
			if (command.isEmpty()) {
				return true;
			}

			if (gateway == null || !gateway.submit(message)) display("[Codex] Gateway 尚未连接；指令未提交。请检查服务和配置。", worldGeneration);
			return false;
		});
	}

	private void display(String message, long generation) {
		Minecraft.getInstance().execute(() -> {
			if (generation == worldGeneration && Minecraft.getInstance().player != null) Minecraft.getInstance().gui.getChat().addMessage(Component.literal(message));
		});
	}
}
