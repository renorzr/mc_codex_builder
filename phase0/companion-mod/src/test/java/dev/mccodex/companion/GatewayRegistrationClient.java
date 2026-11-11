package dev.mccodex.companion;

import java.net.URI;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** A WebSocket handshake without client.registered must not leave the transport stuck forever. */
public final class GatewayRegistrationClient {
	public static void main(String[] args) throws Exception {
		CountDownLatch retry = new CountDownLatch(1);
		try (var connection = new GatewayConnection(new GatewayConfig(URI.create(args[0]), args[1]), text -> {
			if (text.contains("正在重连")) retry.countDown();
		})) {
			connection.setWorld(UUID.randomUUID().toString());
			if (!retry.await(8, TimeUnit.SECONDS)) throw new IllegalStateException("Missing registration timeout");
			if (connection.isReady()) throw new IllegalStateException("Unregistered connection marked ready");
			if (connection.submit("@codex must-not-submit")) throw new IllegalStateException("Accepted command without registration");
		}
		System.out.println("JAVA_GATEWAY_REGISTRATION_TIMEOUT_OK");
	}
}
