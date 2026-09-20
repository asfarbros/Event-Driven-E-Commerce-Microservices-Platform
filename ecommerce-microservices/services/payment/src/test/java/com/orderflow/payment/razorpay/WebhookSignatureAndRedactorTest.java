package com.orderflow.payment.razorpay;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class WebhookSignatureAndRedactorTest {

    // Known vector: HMAC-SHA256("hello", "secret") — independently verifiable with `echo -n hello | openssl dgst -sha256 -hmac secret`.
    private static final String HELLO_SECRET = "88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b";

    @Test
    void signsLikeRazorpay() {
        assertThat(WebhookSignature.sign("hello", "secret")).isEqualTo(HELLO_SECRET);
    }

    @Test
    void verifiesTheRawBodyOnly() {
        String body = "{\"event\":\"payment.captured\",\"payload\":{\"a\":1}}";
        String sig = WebhookSignature.sign(body, "whsec");
        assertThat(WebhookSignature.verify(body, sig, "whsec")).isTrue();
        assertThat(WebhookSignature.verify(body, sig.toUpperCase(), "whsec")).as("case-insensitive hex").isTrue();
        // The same JSON re-serialised with different whitespace is a DIFFERENT byte string → must fail.
        assertThat(WebhookSignature.verify("{\"event\": \"payment.captured\", \"payload\": {\"a\": 1}}", sig, "whsec")).isFalse();
        assertThat(WebhookSignature.verify(body, sig, "other-secret")).isFalse();
        assertThat(WebhookSignature.verify(body, "", "whsec")).isFalse();
        assertThat(WebhookSignature.verify(body, null, "whsec")).isFalse();
        assertThat(WebhookSignature.verify(null, sig, "whsec")).isFalse();
    }

    @Test
    void redactorRemovesInstrumentAndContactFieldsEverywhere() throws Exception {
        JsonNode body = new ObjectMapper().readTree("""
                {"event":"payment.captured","payload":{"payment":{"entity":{
                  "id":"pay_1","amount":100,"order_id":"order_1","method":"card","status":"captured",
                  "card_id":"card_1","card":{"last4":"1111","network":"Visa"},"vpa":"a@upi","email":"a@b.c","contact":"+91999",
                  "customer_id":"cust_1","token_id":"token_1","acquirer_data":{"auth_code":"1"},
                  "notes":{"orderId":"ord-1"},"error_description":null}}}}
                """);
        JsonNode redacted = PayloadRedactor.redact(body);
        JsonNode e = redacted.path("payload").path("payment").path("entity");
        for (String gone : PayloadRedactor.REMOVE) {
            assertThat(e.has(gone)).as(gone).isFalse();
        }
        assertThat(e.get("id").asText()).isEqualTo("pay_1");
        assertThat(e.get("amount").asLong()).isEqualTo(100);
        assertThat(e.get("order_id").asText()).isEqualTo("order_1");
        assertThat(e.get("notes").get("orderId").asText()).isEqualTo("ord-1");
        assertThat(redacted.toString()).doesNotContain("1111").doesNotContain("a@b.c").doesNotContain("+91999");
    }
}
