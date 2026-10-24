package com.privateshare.signal;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.privateshare.auth.AuthController.SessionStore;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.*;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.time.Instant;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ConcurrentHashMap;

/** Server-side authorization for short-lived signalling sessions. File bytes are never accepted here. */
@Component
public class SignalHandler extends TextWebSocketHandler {
  private static final int MAX_MESSAGE = 16_384;
  private static final long TRANSFER_TTL_SECONDS = 15 * 60;
  private static final long CONNECTED_TTL_SECONDS = 60 * 60;
  private static final Set<String> TYPES = Set.of("invite", "accept", "reject", "offer", "answer", "ice", "cancel", "share");
  private final ObjectMapper mapper = new ObjectMapper();
  private final ScheduledExecutorService cleaner = Executors.newSingleThreadScheduledExecutor(r->{Thread t=new Thread(r,"signal-session-cleaner");t.setDaemon(true);return t;});
  private final ConcurrentHashMap<String, WebSocketSession> online = new ConcurrentHashMap<>();
  private final ConcurrentHashMap<String, String> socketUser = new ConcurrentHashMap<>();
  private final ConcurrentHashMap<String, String> socketToken = new ConcurrentHashMap<>();
  private final ConcurrentHashMap<String, String> displayNames = new ConcurrentHashMap<>();
  private final ConcurrentHashMap<String, Transfer> transfers = new ConcurrentHashMap<>();
  private final ConcurrentHashMap<String, WindowCounter> rates = new ConcurrentHashMap<>();

  private static final class Transfer {
    final String id, sender, recipient;
    final boolean media;
    volatile String offerer;
    volatile String state = "INVITED";
    volatile long updated = Instant.now().getEpochSecond();
    Transfer(String id, String sender, String recipient, boolean media) { this.id=id; this.sender=sender; this.recipient=recipient; this.media=media; }
    boolean party(String id) { return sender.equals(id) || recipient.equals(id); }
    String other(String id) { return sender.equals(id) ? recipient : sender; }
  }
  private static final class WindowCounter {
    long start = System.currentTimeMillis(); int count;
    synchronized boolean allow(int limit) { long now=System.currentTimeMillis(); if(now-start>=60_000){start=now;count=0;} return ++count <= limit; }
  }

  public SignalHandler() {
    cleaner.scheduleAtFixedRate(()->online.forEach((id,s)->{
      if(SessionStore.get(socketToken.get(s.getId()))==null)try{s.close(CloseStatus.NOT_ACCEPTABLE.withReason("Session expired"));}catch(Exception ignored){}
    }),1,1,TimeUnit.MINUTES);
  }
  @Override public void afterConnectionEstablished(WebSocketSession s) {
    cleaner.schedule(()->{if(!socketUser.containsKey(s.getId()))try{s.close(CloseStatus.NOT_ACCEPTABLE.withReason("Authentication timed out"));}catch(Exception ignored){}},10,TimeUnit.SECONDS);
  }

  @Override protected void handleTextMessage(WebSocketSession s, TextMessage message) throws Exception {
    if (message.getPayloadLength() > MAX_MESSAGE) { s.close(CloseStatus.TOO_BIG_TO_PROCESS); return; }
    JsonNode n;
    try { n=mapper.readTree(message.getPayload()); } catch(Exception e) { s.close(CloseStatus.BAD_DATA); return; }
    String socketId=s.getId();
    String from=socketUser.get(socketId);
    if (from == null) {
      if (!"auth".equals(n.path("type").asText())) { s.close(CloseStatus.NOT_ACCEPTABLE.withReason("Authenticate first")); return; }
      SessionStore.Session user=SessionStore.get(n.path("token").asText());
      if(user==null){s.close(CloseStatus.NOT_ACCEPTABLE.withReason("Invalid session"));return;}
      WebSocketSession old=online.put(user.id(),s);
      if(old!=null && old!=s){closeSessionsForUser(user.id());socketUser.remove(old.getId());socketToken.remove(old.getId()); try{old.close(CloseStatus.NORMAL.withReason("Replaced by a newer session"));}catch(Exception ignored){}}
      socketUser.put(socketId,user.id()); socketToken.put(socketId,n.path("token").asText());
      displayNames.put(user.id(),safeName(n.path("displayName").asText(user.displayName())));
      sendText(s,mapper.writeValueAsString(mapper.createObjectNode().put("type","ready").put("userId",user.id())));
      broadcastPresence(); return;
    }
    if(SessionStore.get(socketToken.get(socketId))==null) { s.close(CloseStatus.NOT_ACCEPTABLE.withReason("Session expired")); return; }
    if (!rates.computeIfAbsent(from,k->new WindowCounter()).allow(120)) { s.close(CloseStatus.POLICY_VIOLATION.withReason("Rate limit")); return; }
    String type=n.path("type").asText();
    if("presence".equals(type)){broadcastPresence();return;}
    if("profile".equals(type)){displayNames.put(from,safeName(n.path("displayName").asText("Private user")));broadcastPresence();return;}
    if(!TYPES.contains(type)) return;
    String to=n.path("to").asText(""); String id=n.path("transferId").asText("");
    if(to.isBlank() || id.isBlank() || id.length()>80) return;
    String payloadSize=n.path("payload").toString();
    if(payloadSize.length()>12_000){s.close(CloseStatus.TOO_BIG_TO_PROCESS);return;}
    long now=Instant.now().getEpochSecond();
    transfers.entrySet().removeIf(e->"CLOSED".equals(e.getValue().state) || now-e.getValue().updated>("CONNECTED".equals(e.getValue().state)?CONNECTED_TTL_SECONDS:TRANSFER_TTL_SECONDS));
    if ("invite".equals(type)) {
      if(from.equals(to) || !n.hasNonNull("payload")) { error(s,id,"Invalid invitation."); return; }
      long active=transfers.values().stream().filter(x->x.party(from) && !"CLOSED".equals(x.state) && now-x.updated<=TRANSFER_TTL_SECONDS).count();
      if(active>=5){error(s,id,"Too many active sessions. End a session and retry.");return;}
      WebSocketSession target=online.get(to); if(target==null||!target.isOpen()){error(s,id,"The recipient is offline. Ask them to sign in with another Google account.");return;}
      String mediaMode=n.path("payload").path("mediaMode").asText("");
      if(!mediaMode.isEmpty() && !Set.of("voice","video","screen").contains(mediaMode)){error(s,id,"Invalid call type.");return;}
      Transfer fresh=new Transfer(id,from,to,!mediaMode.isEmpty());
      if(transfers.putIfAbsent(id,fresh)!=null){error(s,id,"Duplicate session ID.");return;}
      forward(target,type,from,to,id,n.get("payload"));return;
    }
    Transfer t=transfers.get(id);
    if(t==null)return;
    synchronized(t){
    switch(type){
      case "accept" -> {
        if(t==null||!t.recipient.equals(from)||!t.sender.equals(to)||!"INVITED".equals(t.state))return;
        t.state="ACCEPTED";t.updated=now; forward(online.get(t.sender),type,from,to,id,n.get("payload"));
      }
      case "reject" -> {
        if(t==null||!t.recipient.equals(from)||!t.sender.equals(to)||!"INVITED".equals(t.state))return;
        t.state="CLOSED";t.updated=now;forward(online.get(t.sender),type,from,to,id,n.get("payload"));
      }
      case "offer" -> {
        if(t.media && "OFFERED".equals(t.state) && t.party(from) && t.other(from).equals(to)){error(s,id,"Negotiation in progress; wait for the other offer.");return;}
        if(!t.party(from)||!t.other(from).equals(to)||!("ACCEPTED".equals(t.state) && t.sender.equals(from) || t.media && "CONNECTED".equals(t.state)))return;
        t.offerer=from;t.state="OFFERED";t.updated=now;forward(online.get(to),type,from,to,id,n.get("payload"));
      }
      case "answer" -> {
        if(t==null||!t.party(from)||!t.other(from).equals(to)||!"OFFERED".equals(t.state)||!to.equals(t.offerer))return;
        t.state="CONNECTED";t.updated=now;forward(online.get(to),type,from,to,id,n.get("payload"));
      }
      case "ice" -> {
        if(t==null||!t.party(from)||!t.other(from).equals(to)||!(Set.of("ACCEPTED","OFFERED","CONNECTED").contains(t.state)))return;
        t.updated=now;forward(online.get(to),type,from,to,id,n.get("payload"));
      }
      case "share" -> {
        if(t==null||!t.media||!t.party(from)||!t.other(from).equals(to)||!Set.of("CONNECTED","OFFERED").contains(t.state))return;
        t.updated=now;forward(online.get(to),type,from,to,id,n.get("payload"));
      }
      case "cancel" -> {
        if(t==null||!t.party(from)||!t.other(from).equals(to))return;
        t.state="CLOSED";t.updated=now;forward(online.get(to),type,from,to,id,n.get("payload"));
      }
    }
    }
  }
  private void closeSessionsForUser(String id) {
    for(Transfer t:transfers.values())if(t.party(id))synchronized(t){if(!"CLOSED".equals(t.state)){t.state="CLOSED";try{forward(online.get(t.other(id)),"cancel",id,t.other(id),t.id,null);}catch(Exception ignored){}}}
  }
  private void error(WebSocketSession s,String id,String message)throws Exception { sendText(s,mapper.writeValueAsString(mapper.createObjectNode().put("type","error").put("transferId",id).put("message",message))); }
  private void forward(WebSocketSession target,String type,String from,String to,String id,JsonNode payload)throws Exception{
    if(target==null||!target.isOpen())return;
    ObjectNode out=mapper.createObjectNode().put("type",type).put("from",from).put("to",to).put("transferId",id);
    if(payload!=null&&!payload.isNull())out.set("payload",payload);
    sendText(target,mapper.writeValueAsString(out));
  }
  private void sendText(WebSocketSession s,String json)throws Exception { if(s==null)return; synchronized(s){if(s.isOpen())s.sendMessage(new TextMessage(json));} }
  private void broadcastPresence() throws Exception {
    ObjectNode out=mapper.createObjectNode().put("type","presence");
    var arr=out.putArray("users"); online.forEach((id,s)->{if(s.isOpen())arr.addObject().put("id",id).put("displayName",displayNames.getOrDefault(id,"Online user"));});
    String json=mapper.writeValueAsString(out);
    for(WebSocketSession s:online.values())sendText(s,json);
  }
  private String safeName(String input){if(input==null)return "Private user";String c=input.replaceAll("[\\p{Cntrl}]","").trim().replaceAll("\\s+"," ");if(c.isBlank())return "Private user";return c.substring(0,Math.min(32,c.length()));}
  @Override public void afterConnectionClosed(WebSocketSession s,CloseStatus status)throws Exception{
    String id=socketUser.remove(s.getId()); socketToken.remove(s.getId()); if(id!=null){online.remove(id,s);if(!online.containsKey(id)){displayNames.remove(id); rates.remove(id); closeSessionsForUser(id);}} broadcastPresence();
  }
  @Override public void handleTransportError(WebSocketSession s,Throwable ex)throws Exception{if(s.isOpen())s.close(CloseStatus.SERVER_ERROR);}
}
