package com.privateshare.auth;

import com.google.api.client.googleapis.auth.oauth2.GoogleIdToken;
import com.google.api.client.googleapis.auth.oauth2.GoogleIdTokenVerifier;
import com.google.api.client.http.javanet.NetHttpTransport;
import com.google.api.client.json.gson.GsonFactory;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.Base64;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

@RestController
@RequestMapping("/api/auth")
public class AuthController {
  public record LoginRequest(String credential) {}
  public record UserSession(String token, String id, String displayName, String email, long expiresAt) {}
  public static final class SessionStore {
    public record Session(String id, String displayName, String email, long expiresAt) {}
    public static final ConcurrentHashMap<String, Session> SESSIONS = new ConcurrentHashMap<>();
    static {
      var cleaner = Executors.newSingleThreadScheduledExecutor(r -> { Thread t = new Thread(r, "session-cleaner"); t.setDaemon(true); return t; });
      cleaner.scheduleAtFixedRate(() -> { long now=Instant.now().getEpochSecond(); SESSIONS.entrySet().removeIf(e -> e.getValue().expiresAt() <= now); }, 1, 1, TimeUnit.MINUTES);
    }
    public static String create(String id, String name, String email) {
      byte[] b = new byte[32]; new SecureRandom().nextBytes(b);
      String token = Base64.getUrlEncoder().withoutPadding().encodeToString(b);
      SESSIONS.put(token, new Session(id, name, email, Instant.now().getEpochSecond() + 3600));
      return token;
    }
    public static Session get(String token) {
      Session s = SESSIONS.get(token);
      if (s == null || s.expiresAt() < Instant.now().getEpochSecond()) { if (token != null) SESSIONS.remove(token); return null; }
      return s;
    }
  }
  @PostMapping("/google")
  public UserSession login(@RequestBody LoginRequest request) {
    String clientId = System.getenv("GOOGLE_CLIENT_ID");
    if (clientId == null || clientId.isBlank() || request == null || request.credential() == null)
      throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Authentication is not configured");
    try {
      GoogleIdTokenVerifier verifier = new GoogleIdTokenVerifier.Builder(new NetHttpTransport(), GsonFactory.getDefaultInstance()).setAudience(java.util.List.of(clientId)).build();
      GoogleIdToken token = verifier.verify(request.credential());
      if (token == null) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Invalid Google credential");
      GoogleIdToken.Payload p = token.getPayload();
      String id = p.getSubject();
      String email = p.getEmail();
      String name = (String)p.get("name");
      if (id == null || !Boolean.TRUE.equals(p.getEmailVerified())) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Account could not be verified");
      String session = SessionStore.create(id, name == null ? "User" : name, email == null ? "" : email);
      return new UserSession(session, id, name == null ? "User" : name, email == null ? "" : email, Instant.now().getEpochSecond() + 3600);
    } catch (ResponseStatusException e) { throw e; }
      catch (Exception e) { throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Google sign-in failed"); }
  }
  @PostMapping("/logout") public Map<String, Boolean> logout(@RequestHeader(value="Authorization", required=false) String header) {
    if (header != null && header.startsWith("Bearer ")) SessionStore.SESSIONS.remove(header.substring(7));
    return Map.of("ok", true);
  }
}
