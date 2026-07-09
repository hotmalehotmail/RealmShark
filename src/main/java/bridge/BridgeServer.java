package bridge;

import org.java_websocket.WebSocket;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.server.WebSocketServer;

import java.net.InetSocketAddress;

/**
 * Minimal local WebSocket server that broadcasts packet JSON to connected UI
 * clients (e.g. an overlay). Bound to loopback only - sniffed game data must
 * never leave the machine.
 * <p>
 * Phase 1 clients are receive-only; subscription/filtering is added later.
 */
public class BridgeServer extends WebSocketServer {

    /** Identifies this server so a client can confirm 47474 isn't some other process. */
    public static final String SERVICE = "realmshark-bridge";
    /** Bumped only on breaking changes to the envelope/handshake wire format. */
    public static final int PROTOCOL_VERSION = 1;

    /** Handles a message received from a client (e.g. a sprite-pack request). */
    public interface MessageHandler {
        void onMessage(WebSocket conn, String message);
    }

    private MessageHandler messageHandler;

    public BridgeServer(int port) {
        super(new InetSocketAddress("127.0.0.1", port));
        setReuseAddr(true);
    }

    /** Registers the handler for inbound client messages (replaces the receive-only default). */
    public void setMessageHandler(MessageHandler handler) {
        this.messageHandler = handler;
    }

    @Override
    public void onStart() {
        System.out.println("[bridge] WebSocket server listening on ws://127.0.0.1:" + getPort());
    }

    @Override
    public void onOpen(WebSocket conn, ClientHandshake handshake) {
        System.out.println("[bridge] client connected: " + conn.getRemoteSocketAddress());
        // Send a hello frame first thing so the client can verify it reached our
        // bridge (and a compatible protocol) rather than a stray listener on the port.
        conn.send("{\"type\":\"hello\",\"service\":\"" + SERVICE
                + "\",\"protocol\":" + PROTOCOL_VERSION + "}");
    }

    @Override
    public void onClose(WebSocket conn, int code, String reason, boolean remote) {
        System.out.println("[bridge] client disconnected: " + conn.getRemoteSocketAddress());
    }

    @Override
    public void onMessage(WebSocket conn, String message) {
        // Clients are broadcast-only except for a few request/response messages
        // (e.g. the one-time sprite-pack fetch) routed through the handler.
        if (messageHandler != null) {
            messageHandler.onMessage(conn, message);
        }
    }

    @Override
    public void onError(WebSocket conn, Exception ex) {
        System.err.println("[bridge] error: " + ex.getMessage());
    }

    /**
     * Broadcast a message to every connected client.
     *
     * @param message JSON string to send.
     */
    public void send(String message) {
        broadcast(message);
    }
}
