package dev.mccodex.companion;

import com.google.gson.Gson;
import java.io.IOException;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;

public record GatewayConfig(URI url, String token) {
	public GatewayConfig {
		if (url == null || !"ws".equals(url.getScheme()) || !"127.0.0.1".equals(url.getHost())
				|| url.getPort() < 1 || url.getPort() > 65535 || !"/ws".equals(url.getPath())
				|| url.getUserInfo() != null || url.getQuery() != null || url.getFragment() != null) {
			throw new IllegalArgumentException("Gateway URL 必须为 ws://127.0.0.1:<port>/ws");
		}
		if (token == null || !token.matches("[A-Za-z0-9_-]{32,256}")) {
			throw new IllegalArgumentException("Gateway token 格式错误");
		}
	}

	public static GatewayConfig load(Path file) throws IOException {
		try {
			var config = new Gson().fromJson(Files.readString(file), ConfigFile.class);
			return new GatewayConfig(URI.create(config.url), config.token);
		} catch (RuntimeException exception) {
			// Do not include JSON, URLs or token values in errors.
			throw new IOException("Gateway 配置无效，请检查 url 和 token");
		}
	}

	private record ConfigFile(String url, String token) {}
}
