package dev.mccodex.companion;

import java.net.URI;
import java.time.Duration;
import java.util.UUID;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** Exercises the production transport across a real Node Gateway restart. */
public final class GatewayRecoveryClient {
	public static void main(String[] args) throws Exception {
		CountDownLatch first = new CountDownLatch(1), disconnected = new CountDownLatch(1), burst = new CountDownLatch(12);
		Set<String> seen = ConcurrentHashMap.newKeySet();
		try (var connection = new GatewayConnection(new GatewayConfig(URI.create(args[0]), args[1]), text -> {
			System.out.println(text);
			if (text.equals("[Codex] 模拟回复：restart-first")) first.countDown();
			if (text.contains("正在重连")) disconnected.countDown();
			if (text.startsWith("[Codex] 模拟回复：restart-burst-") && seen.add(text)) burst.countDown();
		})) {
			connection.setWorld(UUID.randomUUID().toString());
			waitReady(connection);
			if (!connection.submit("@codex restart-first")) throw new IllegalStateException("First submit failed");
			if (!first.await(8, TimeUnit.SECONDS)) throw new IllegalStateException("No first reply");
			System.out.println("JAVA_RESTART_GATEWAY_NOW");
			if (!disconnected.await(8, TimeUnit.SECONDS)) throw new IllegalStateException("No disconnect detected");
			waitReady(connection);
			for (int i = 0; i < 12; i++) if (!connection.submit("@codex restart-burst-" + i)) throw new IllegalStateException("Burst submit failed");
			if (!burst.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("Burst replies missing: " + burst.getCount());
		}
		System.out.println("JAVA_GATEWAY_RECOVERY_OK");
	}

	private static void waitReady(GatewayConnection connection) throws InterruptedException {
		long end = System.nanoTime() + Duration.ofSeconds(8).toNanos();
		while (!connection.isReady() && System.nanoTime() < end) Thread.sleep(10);
		if (!connection.isReady()) throw new IllegalStateException("Registration timed out");
	}
}
