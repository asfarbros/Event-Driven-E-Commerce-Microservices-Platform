package com.orderflow.payment.web;

import java.util.List;

import com.orderflow.payment.config.PaymentProperties;
import com.orderflow.payment.service.PaymentService;
import com.orderflow.payment.web.ApiDtos.CreatePaymentRequest;
import com.orderflow.payment.web.ApiDtos.CreatePaymentResponse;
import com.orderflow.payment.web.ApiDtos.FieldError;
import com.orderflow.payment.web.ApiDtos.PaymentResponse;
import com.orderflow.payment.web.ApiDtos.RefundRequest;
import com.orderflow.payment.web.ApiDtos.RefundResult;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Pattern;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * Payment REST surface. The gateway strips {@code /api/payments}.
 *
 * <p><b>Why the browser must never influence the amount.</b> {@code POST
 * /payments} is called SERVER-TO-SERVER by Order Service with the amount it
 * computed from Cart's priced snapshot. We record that amount, create the
 * Razorpay order with it, and Razorpay binds the amount to the order id. The
 * browser only receives {@code razorpayOrderId} + the public key id to open
 * the widget: whatever a tampered client displays or submits, Razorpay charges
 * the amount attached to the order on its side, and our webhook processing
 * re-checks the captured amount against our row. A client-supplied amount
 * would let anyone pay 1 paisa for anything.
 *
 * <p>TODO(auth-roles): once the gateway propagates roles, {@code POST
 * /payments} and {@code /refund} should be limited to service / admin
 * identities; today the gateway only guarantees an authenticated user, and
 * Order Service calls this service directly (not through the gateway).
 */
@RestController
@Validated
public class PaymentController {

    private final PaymentService service;
    private final PaymentProperties properties;

    public PaymentController(PaymentService service, PaymentProperties properties) {
        this.service = service;
        this.properties = properties;
    }

    /** 201 new payment (PENDING at Razorpay), 200 existing one (replay). Amount is integer paise. */
    @PostMapping("/payments")
    public ResponseEntity<CreatePaymentResponse> create(@Valid @RequestBody CreatePaymentRequest body) {
        if (body.amountInPaise() > properties.maxAmountInPaise()) {
            throw new ApiExceptionHandler.BadRequestException(List.of(
                    new FieldError("amountInPaise", "must be at most " + properties.maxAmountInPaise() + " (PAYMENT_MAX_AMOUNT_IN_PAISE)")));
        }
        if (!body.currency().equals(properties.defaultCurrency())) {
            throw new ApiExceptionHandler.BadRequestException(List.of(
                    new FieldError("currency", "must be " + properties.defaultCurrency() + " (the only currency this deployment accepts)")));
        }
        PaymentService.CreateResult result = service.create(body.orderId(), body.userId(), body.amountInPaise(), body.currency());
        return ResponseEntity.status(result.created() ? HttpStatus.CREATED : HttpStatus.OK)
                .body(CreatePaymentResponse.of(result.payment(), result.created(), properties.razorpay().keyId()));
    }

    @GetMapping("/payments/{orderId}")
    public PaymentResponse get(@PathVariable @Pattern(regexp = ApiDtos.ID_PATTERN, message = ApiDtos.ID_MESSAGE) String orderId) {
        return PaymentResponse.of(service.getByOrderId(orderId));
    }

    /** Explicit refund (support / Order Service). Idempotent; 409 nothing_to_refund if no money was taken. */
    @PostMapping("/payments/{orderId}/refund")
    public RefundResult refund(@PathVariable @Pattern(regexp = ApiDtos.ID_PATTERN, message = ApiDtos.ID_MESSAGE) String orderId,
                               @Valid @RequestBody(required = false) RefundRequest body) {
        String reason = body != null && body.reason() != null && !body.reason().isBlank() ? body.reason() : "manual";
        PaymentService.RefundResult result = service.refund(orderId, reason, null, true);
        return new RefundResult(result.outcome().name(), PaymentResponse.of(result.payment()));
    }
}
