package com.orderflow.payment.razorpay;

import java.util.Iterator;
import java.util.Map;
import java.util.Set;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

/**
 * Strips sensitive fields from a Razorpay webhook body before it is stored in
 * webhook_event.payload or appears anywhere near a log line.
 *
 * <p>Removed wherever they occur: card details, UPI VPA, customer email and
 * phone, customer/token ids, bank account fields, acquirer data. Kept: ids,
 * amounts, statuses, method, error codes, notes (our own metadata), timestamps
 * — everything support needs to explain what happened.
 */
public final class PayloadRedactor {

    static final Set<String> REMOVE = Set.of(
            "card", "card_id", "vpa", "email", "contact", "customer_id", "token_id", "token",
            "bank_account", "acquirer_data", "upi", "emi", "wallet", "international", "customer_details",
            "billing_address", "shipping_address");

    private PayloadRedactor() {
    }

    /** Returns the same tree, mutated in place, with sensitive fields removed. */
    public static JsonNode redact(JsonNode node) {
        if (node == null) {
            return null;
        }
        if (node.isObject()) {
            ObjectNode obj = (ObjectNode) node;
            Iterator<Map.Entry<String, JsonNode>> fields = obj.fields();
            while (fields.hasNext()) {
                Map.Entry<String, JsonNode> f = fields.next();
                if (REMOVE.contains(f.getKey())) {
                    fields.remove();
                } else {
                    redact(f.getValue());
                }
            }
        } else if (node.isArray()) {
            for (JsonNode child : node) {
                redact(child);
            }
        }
        return node;
    }
}
