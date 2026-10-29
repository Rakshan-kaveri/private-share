package com.privateshare.signal;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

@Configuration @EnableWebSocket
public class SignalConfig implements WebSocketConfigurer {
  private final SignalHandler handler;
  public SignalConfig(SignalHandler handler) { this.handler = handler; }
  @Override public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
    registry.addHandler(handler, "/ws").setAllowedOriginPatterns(System.getenv().getOrDefault("APP_ORIGIN", "http://localhost:8080"));
  }
}
