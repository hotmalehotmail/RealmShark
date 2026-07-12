package bridge;

import org.junit.Test;
import packets.incoming.DamagePacket;
import packets.outgoing.HelloPacket;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Guards the credential-stripping in {@link PacketSerializer}: login/device
 * tokens carried on {@code HelloPacket} must never appear in the serialized JSON,
 * because that JSON reaches WebSocket clients and the public "Report bug" dump.
 * See {@code PacketSerializer.SENSITIVE_FIELDS}.
 */
public class PacketSerializerTest {

    @Test
    public void stripsHelloCredentials() {
        HelloPacket hello = new HelloPacket();
        hello.accessToken = "SECRET_ACCESS_TOKEN";
        hello.platformToken = "SECRET_PLATFORM_TOKEN";
        hello.clientToken = "SECRET_CLIENT_HWID";
        hello.userToken = "SECRET_USER_TOKEN";

        String json = new PacketSerializer().toJson(hello);

        assertFalse("accessToken value leaked", json.contains("SECRET_ACCESS_TOKEN"));
        assertFalse("platformToken value leaked", json.contains("SECRET_PLATFORM_TOKEN"));
        assertFalse("clientToken value leaked", json.contains("SECRET_CLIENT_HWID"));
        assertFalse("userToken value leaked", json.contains("SECRET_USER_TOKEN"));
        // The field keys should be gone too, not just the values.
        assertFalse("accessToken key present", json.contains("accessToken"));
        assertFalse("clientToken key present", json.contains("clientToken"));
    }

    @Test
    public void keepsNonSensitiveFields() {
        DamagePacket dmg = new DamagePacket();
        dmg.objectId = 424242;
        dmg.damageAmount = 1337;

        String json = new PacketSerializer().toJson(dmg);

        assertTrue("normal field key missing", json.contains("objectId"));
        assertTrue("normal field value missing", json.contains("424242"));
        assertTrue("damageAmount missing", json.contains("1337"));
    }
}
