package bridge.dps;

import java.util.ArrayList;

public class PcStatsDecoder {

    private static int readCounter;

    public static int[] decodePsStats(String string) {
        byte[] byteArray = sixBitStringToBytes(string);
        ArrayList<Integer> stats = new ArrayList<>();

        readCounter = 0;
        while (readCounter < byteArray.length) {
            int o = readCompressedInt(byteArray, readCounter);
            stats.add(o);
        }

        return stats.stream().mapToInt(Integer::intValue).toArray();
    }

    private static int readCompressedInt(byte[] bytes, int offset) {
        int uByte = readUnsignedByte(bytes, offset);
        boolean isNegative = (uByte & 64) != 0;
        int shift = 6;
        int value = uByte & 63;

        int i = offset + 1;
        while ((uByte & 128) != 0) {
            uByte = readUnsignedByte(bytes, i);
            value |= (uByte & 127) << shift;
            shift += 7;
            i++;
        }

        if (isNegative) {
            value = -value;
        }
        return value;
    }

    private static int readUnsignedByte(byte[] bytes, int offset) {
        readCounter++;
        return Byte.toUnsignedInt(bytes[offset]);
    }

    public static byte[] sixBitStringToBytes(String string) {
        int indexPadding = string.indexOf('=');
        int stringLength = string.length();
        int padding = 0;
        if (indexPadding > -1) {
            padding = stringLength - indexPadding;
        }
        byte[] output = new byte[(stringLength / 4) * 3 - padding];
        int o = 0;
        for (int i = 0; i < stringLength; i += 4) {
            int value1 = charValue(string.charAt(i));
            int value2 = charValue(string.charAt(i + 1));
            char c3 = string.charAt(i + 2);
            char c4 = string.charAt(i + 3);
            int value3 = charValue(c3);
            int value4 = charValue(c4);

            byte o1 = (byte) (value1 << 2 | value2 >> 4);
            byte o2 = (byte) ((value2 & 0b001111) << 4 | value3 >> 2);
            byte o3 = (byte) ((value3 & 0b000011) << 6 | value4);

            output[o] = o1;
            if (c3 != '=') { // excludes padding
                output[1 + o] = o2;
                if (c4 != '=') {
                    output[2 + o] = o3;
                }
            }
            o += 3;
        }
        return output;
    }

    private static int charValue(char c) {
        if (c >= 48 && c <= 57) return c + 4; // 0(52) - 9(61)
        if (c >= 65 && c <= 90) return c - 65; // A(0) - Z(25)
        if (c >= 97 && c <= 122) return c - 71; // a(26) - z(51)
        if (c == '-') return 62; // (62)
        if (c == '_') return 63; // (63)
        if (c == '=') return 0; // (padding)
        return c;
    }

    /**
     * Inverse of {@link #sixBitStringToBytes}: packs a byte array into the same
     * six-bit (base64url-like) string encoding. Used by {@code FakePacketSource}
     * and tests to synthesize encoded stat strings (e.g. UNIQUE_DATA_STRING) with
     * no game running; never used on the live decode path.
     */
    public static String bytesToSixBitString(byte[] bytes) {
        StringBuilder sb = new StringBuilder();
        int len = bytes.length;
        for (int i = 0; i < len; i += 3) {
            int b1 = bytes[i] & 0xFF;
            int b2 = (i + 1 < len) ? (bytes[i + 1] & 0xFF) : 0;
            int b3 = (i + 2 < len) ? (bytes[i + 2] & 0xFF) : 0;

            int v1 = b1 >> 2;
            int v2 = ((b1 & 0b11) << 4) | (b2 >> 4);
            int v3 = ((b2 & 0b1111) << 2) | (b3 >> 6);
            int v4 = b3 & 0b111111;

            sb.append(sixBitChar(v1));
            sb.append(sixBitChar(v2));
            sb.append(i + 1 < len ? sixBitChar(v3) : '=');
            sb.append(i + 2 < len ? sixBitChar(v4) : '=');
        }
        return sb.toString();
    }

    private static char sixBitChar(int v) {
        if (v < 26) return (char) ('A' + v); // 0-25
        if (v < 52) return (char) ('a' + (v - 26)); // 26-51
        if (v < 62) return (char) ('0' + (v - 52)); // 52-61
        if (v == 62) return '-';
        return '_'; // 63
    }
}
