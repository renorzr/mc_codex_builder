import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

public final class GatewayWebSocketProbe implements WebSocket.Listener {
	private final CountDownLatch messages = new CountDownLatch(2);
	private final StringBuilder text = new StringBuilder();

	public static void main(String[] args) throws Exception {
		if (args.length != 2) throw new IllegalArgumentException("usage: <ws-url> <token>");
		GatewayWebSocketProbe listener = new GatewayWebSocketProbe();
		WebSocket socket = HttpClient.newHttpClient().newWebSocketBuilder()
				.header("Authorization", "Bearer " + args[1])
				.buildAsync(URI.create(args[0]), listener)
				.join();
		socket.sendText("{\"type\":\"companion.probe\",\"protocolVersion\":1}", true).join();
		if (!listener.messages.await(10, TimeUnit.SECONDS)) {
			throw new IllegalStateException("timed out waiting for gateway messages");
		}
		socket.sendClose(WebSocket.NORMAL_CLOSURE, "done").join();
		System.out.println("JAVA_WEBSOCKET_PROBE_OK");
	}

	@Override
	public void onOpen(WebSocket webSocket) {
		webSocket.request(1);
	}

	@Override
	public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
		text.append(data);
		if (last) {
			String message = text.toString();
			text.setLength(0);
			if (!message.contains("\"protocolVersion\":1") && !message.contains("gateway.echo")) {
				throw new IllegalStateException("unexpected message: " + message);
			}
			messages.countDown();
		}
		webSocket.request(1);
		return null;
	}
}
