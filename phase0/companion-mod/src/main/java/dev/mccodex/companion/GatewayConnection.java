package dev.mccodex.companion;

import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

/** Game-independent transport. The caller dispatches all display callbacks to the client thread. */
public final class GatewayConnection implements AutoCloseable {
	private final GatewayConfig config;
	private final Consumer<String> display;
	private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor(runnable -> {
		Thread thread = new Thread(runnable, "codex-gateway");
		thread.setDaemon(true);
		return thread;
	});
	private final HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).executor(scheduler).build();
	private WebSocket socket;
	private String world;
	private long generation;
	private int attempts;
	private boolean ready;
	private boolean closed;

	public GatewayConnection(GatewayConfig config, Consumer<String> display) {
		this.config = config;
		this.display = display;
	}

	public synchronized void setWorld(String worldSessionId) {
		if (closed) return;
		generation++;
		ready = false;
		if (socket != null) {
			socket.abort();
			socket = null;
		}
		world = worldSessionId;
		attempts = 0;
		if (world != null) connect(generation);
	}

	public synchronized boolean isReady() { return ready; }

	/** Never queues or automatically replays a user command after a disconnect. */
	public synchronized boolean submit(String text) {
		if (!ready || socket == null || world == null || closed) return false;
		if (text.length() > 8000) { display.accept("[Codex] 指令过长（最多 8000 字符）。"); return true; }
		var payload = GatewayProtocol.worldPayload(world);
		payload.addProperty("text", text);
		String message = GatewayProtocol.message("chat.command", payload);
		socket.sendText(message, true).whenComplete((ignored, error) -> {
			if (error != null) display.accept("[Codex] 提交结果未知，请重连后查询状态；指令不会自动重发。");
		});
		return true;
	}

	private synchronized void connect(long expected) {
		if (closed || generation != expected || world == null) return;
		attempts++;
		Listener listener = new Listener(expected);
		client.newWebSocketBuilder().connectTimeout(Duration.ofSeconds(5))
				.header("Authorization", "Bearer " + config.token()).buildAsync(config.url(), listener)
				.whenComplete((connection, error) -> {
					if (error != null) listener.failed();
				});
	}

	private synchronized void retry(long expected) {
		if (closed || generation != expected || world == null) return;
		ready = false;
		socket = null;
		if (attempts >= 5) {
			display.accept("[Codex] Gateway 连接失败，已停止重试；检查配置后重新进入世界。");
			return;
		}
		display.accept("[Codex] Gateway 已断开，正在重连……");
		long waitMs = Math.min(8000, 500L << Math.max(0, attempts - 1));
		scheduler.schedule(() -> connect(expected), waitMs, TimeUnit.MILLISECONDS);
	}

	@Override
	public synchronized void close() {
		if (closed) return;
		closed = true;
		generation++;
		ready = false;
		world = null;
		if (socket != null) socket.abort();
		scheduler.shutdownNow();
		client.shutdownNow();
	}

	private final class Listener implements WebSocket.Listener {
		private final long expected;
		private final StringBuilder fragments = new StringBuilder();
		private int bytes;
		private boolean failed;

		Listener(long expected) { this.expected = expected; }

		@Override
		public void onOpen(WebSocket connection) {
			synchronized (GatewayConnection.this) {
				if (closed || generation != expected || world == null) { connection.abort(); return; }
				socket = connection;
				connection.sendText(GatewayProtocol.message("client.ready", GatewayProtocol.worldPayload(world)), true);
			}
			connection.request(1);
		}

		@Override
		public CompletionStage<?> onText(WebSocket connection, CharSequence data, boolean last) {
			try {
				bytes += data.toString().getBytes(StandardCharsets.UTF_8).length;
				if (bytes > GatewayProtocol.MAX_MESSAGE_BYTES) throw new IllegalArgumentException("Message too large");
				fragments.append(data);
				if (last) {
					var message = GatewayProtocol.parse(fragments.toString());
					fragments.setLength(0);
					bytes = 0;
					synchronized (GatewayConnection.this) {
						if (closed || generation != expected) return null;
						if (message.get("type").getAsString().equals("client.registered")) {
							ready = world != null && world.equals(message.getAsJsonObject("payload").get("worldSessionId").getAsString());
							if (ready) attempts = 0;
						}
						String rendered = GatewayProtocol.render(message);
						if (rendered != null) display.accept(rendered);
					}
				}
			} catch (RuntimeException error) {
				connection.abort();
				failed();
			}
			connection.request(1);
			return null;
		}

		@Override
		public CompletionStage<?> onClose(WebSocket connection, int code, String reason) { failed(); return null; }

		@Override
		public void onError(WebSocket connection, Throwable error) { failed(); }

		synchronized void failed() {
			if (failed) return;
			failed = true;
			retry(expected);
		}
	}
}
