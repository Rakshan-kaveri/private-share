package com.privateshare.auth;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.*;

/** Issues short-lived coturn REST credentials to authenticated sessions. */
@RestController
public class IceConfigController {
  @GetMapping("/api/ice-config")
  public Map<String,Object> iceConfig(@RequestHeader(value="Authorization", required=false) String auth) {
    if (auth == null || !auth.startsWith("Bearer ")) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
    var session = AuthController.SessionStore.get(auth.substring(7));
    if (session == null) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
    String host = System.getenv("TURN_HOST");
    String secret = System.getenv("TURN_SHARED_SECRET");
    List<Map<String,Object>> servers = new ArrayList<>();
    servers.add(Map.of("urls", "stun:stun.l.google.com:19302"));
    if (host != null && !host.isBlank() && secret != null && secret.length() >= 32) {
      long expiry = Instant.now().getEpochSecond() + 600;
      String username = expiry + ":" + session.id();
      try {
        Mac mac = Mac.getInstance("HmacSHA1");
        mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA1"));
        String credential = Base64.getEncoder().encodeToString(mac.doFinal(username.getBytes(StandardCharsets.UTF_8)));
        servers.add(Map.of("urls", List.of("turn:" + host + ":3478?transport=udp", "turn:" + host + ":3478?transport=tcp"), "username", username, "credential", credential, "credentialType", "password"));
      } catch (Exception e) { throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "ICE configuration unavailable"); }
    }
    return Map.of("iceServers", servers, "turnConfigured", servers.size() > 1, "credentialExpiresAt", Instant.now().getEpochSecond() + 600);
  }
}
