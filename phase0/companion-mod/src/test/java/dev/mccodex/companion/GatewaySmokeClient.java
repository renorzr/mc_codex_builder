package dev.mccodex.companion;

import java.net.URI;
import java.time.Duration;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** Run against the real Node Gateway without loading Minecraft or Fabric. */
public final class GatewaySmokeClient {
	public static void main(String[] args) throws Exception {
		CountDownLatch completed = new CountDownLatch(1);
		try (var connection = new GatewayConnection(new GatewayConfig(URI.create(args[0]), args[1]), text -> {
			System.out.println(text);
			if (text.contains("模拟回复：Java transport 你好")) completed.countDown();
		})) {
			connection.setWorld(UUID.randomUUID().toString());
			long deadline = System.nanoTime() + Duration.ofSeconds(8).toNanos();
			while (!connection.isReady() && System.nanoTime() < deadline) Thread.sleep(10);
			if (!connection.isReady()) throw new IllegalStateException("Gateway registration timed out");
			if (!connection.submit("@codex Java transport 你好")) throw new IllegalStateException("Submit failed");
			if (!completed.await(8, TimeUnit.SECONDS)) throw new IllegalStateException("No mock response");
		}
		System.out.println("JAVA_GATEWAY_SMOKE_OK");
	}
}
