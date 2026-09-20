package com.orderflow.payment.web;

import com.orderflow.payment.correlation.Correlation;
import com.orderflow.payment.service.WebhookService;
import com.orderflow.payment.web.ApiDtos.WebhookAck;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

/**
 * {@code POST /webhooks/razorpay} — called by RAZORPAY, server-to-server. Not
 * a browser route and not behind Clerk: the caller proves itself with the
 * {@code X-Razorpay-Signature} HMAC over the raw body, verified with the
 * webhook secret. See README "Webhooks" for how to expose it (a public URL
 * registered in the Razorpay dashboard; the gateway must NOT put a JWT check
 * in front of it).
 *
 * <p>RAW BODY: the body is bound as a plain {@code String} — Spring hands over
 * the request bytes as-is (no JSON parsing, no re-serialisation), so the HMAC
 * is computed over exactly what Razorpay signed. Nothing upstream of this
 * method reads or rewrites the body.
 *
 * <p>Response codes: 200 for anything we ACCEPTED — processed, ignored (an
 * event type we do not act on) or duplicate — so Razorpay stops retrying.
 * 400 for an invalid signature or a malformed webhook (Razorpay would only
 * resend the same bad request). 5xx only when we genuinely could not accept
 * it (database down), which is exactly when we want Razorpay to retry.
 */
@RestController
public class WebhookController {

    public static final String SIGNATURE_HEADER = "X-Razorpay-Signature";
    public static final String EVENT_ID_HEADER = "X-Razorpay-Event-Id";

    private final WebhookService webhookService;

    public WebhookController(WebhookService webhookService) {
        this.webhookService = webhookService;
    }

    @PostMapping(value = "/webhooks/razorpay", consumes = MediaType.ALL_VALUE)
    public WebhookAck razorpay(@RequestBody String rawBody,
                               @RequestHeader(value = SIGNATURE_HEADER, required = false) String signature,
                               @RequestHeader(value = EVENT_ID_HEADER, required = false) String eventId) {
        WebhookService.Result result = webhookService.process(rawBody, signature, eventId);
        return new WebhookAck(result.outcome().name().toLowerCase(), result.eventType(), result.note(), Correlation.current());
    }
}
