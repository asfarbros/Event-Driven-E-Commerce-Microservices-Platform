package com.orderflow.payment.razorpay;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Razorpay webhook signature: {@code X-Razorpay-Signature} is the lowercase
 * hex HMAC-SHA256 of the RAW request body, keyed with the webhook secret set
 * in the Razorpay dashboard.
 *
 * <p>"Raw" matters: the HMAC covers the exact bytes Razorpay sent. Parsing the
 * body to JSON and serialising it again reorders keys and changes whitespace,
 * and the signature would never match. The controller therefore reads the body
 * as a String and verifies THAT before anything parses it.
 *
 * <p>The comparison is constant-time so timing cannot leak the expected value.
 */
public final class WebhookSignature {

    private static final String ALGORITHM = "HmacSHA256";

    private WebhookSignature() {
    }

    public static String sign(String rawBody, String secret) {
        try {
            Mac mac = Mac.getInstance(ALGORITHM);
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), ALGORITHM));
            byte[] digest = mac.doFinal(rawBody.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(digest.length * 2);
            for (byte b : digest) {
                hex.append(Character.forDigit((b >> 4) & 0xF, 16)).append(Character.forDigit(b & 0xF, 16));
            }
            return hex.toString();
        } catch (Exception e) {
            throw new IllegalStateException("HMAC-SHA256 unavailable", e);
        }
    }

    public static boolean verify(String rawBody, String signatureHeader, String secret) {
        if (rawBody == null || signatureHeader == null || signatureHeader.isBlank() || secret == null) {
            return false;
        }
        byte[] expected = sign(rawBody, secret).getBytes(StandardCharsets.UTF_8);
        byte[] given = signatureHeader.strip().toLowerCase().getBytes(StandardCharsets.UTF_8);
        return MessageDigest.isEqual(expected, given);
    }
}
