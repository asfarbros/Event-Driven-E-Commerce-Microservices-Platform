package com.orderflow.order.service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.stream.Collectors;

import com.orderflow.order.clients.Clients;
import com.orderflow.order.clients.ServiceClient;
import com.orderflow.order.config.OrderProperties;
import com.orderflow.order.correlation.Correlation;
import com.orderflow.order.domain.Order;
import com.orderflow.order.domain.Order.Trigger;
import com.orderflow.order.domain.OrderStatus;
import com.orderflow.order.domain.OrderRepository;
import com.orderflow.order.domain.OutboxRepository;
import com.orderflow.order.domain.ProcessedEventRepository;
import com.orderflow.order.outbox.OutboxRelay;
import com.orderflow.order.outbox.OutboxWriter;
import com.orderflow.order.service.ServiceExceptions.CheckoutRejectedException;
import com.orderflow.order.service.ServiceExceptions.DependencyUnavailableException;
import com.orderflow.order.service.ServiceExceptions.IdempotencyConflictException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import static net.logstash.logback.argument.StructuredArguments.kv;

/**
 * THE SYNCHRONOUS ZONE of checkout — the user is waiting. Steps, in order:
 *
 * <pre>
 *  1  X-User-Id (gateway-verified)                  — 401 if absent (web layer)
 *  2  Cart /snapshot (strict)                       — cart_empty / cart_unavailable → no order is created
 *  3  Catalog /products/prices → OUR total          — product_unavailable / pricing_unavailable → no order is created
 *  4  INSERT order PENDING + immutable line snapshot + outbox OrderCreated      [tx]
 *  5  Inventory /reserve  (stock BEFORE money)      — short → order FAILED, 409 naming the products; down → FAILED, 503
 *  6  Payment /payments   (our amount)              — down/rejected → RELEASE the hold, order FAILED, 503/502
 *  7  Cart DELETE / (best effort), return what the browser needs for the Razorpay widget
 * </pre>
 *
 * <h3>Compensation matrix</h3>
 * <table>
 *   <tr><th>Failure point</th><th>What already happened</th><th>Compensation</th></tr>
 *   <tr><td>2 cart</td><td>nothing</td><td>none needed; 409 / 503 to the caller</td></tr>
 *   <tr><td>3 catalog</td><td>nothing</td><td>none needed; 409 / 503</td></tr>
 *   <tr><td>5 reserve short</td><td>order PENDING</td><td>order → FAILED(reason: shortages); 409 insufficient_stock; Payment never called</td></tr>
 *   <tr><td>5 inventory down</td><td>order PENDING</td><td>order → FAILED; 503 inventory_unavailable. (Inventory is idempotent on orderId, so a hold
 *       created by a timed-out call is harmless: the OrderCancelled event we queue releases it.)</td></tr>
 *   <tr><td>6 payment down/rejected</td><td>hold taken</td><td>Inventory /release NOW (sync) AND OrderCancelled queued in the outbox
 *       (durable backstop if the sync release also fails); order → FAILED; 503 / 502</td></tr>
 *   <tr><td>7 cart clear fails</td><td>everything</td><td>nothing — the cart is not a source of truth any more; logged</td></tr>
 *   <tr><td>user never pays</td><td>hold + Razorpay order</td><td>nothing active: Inventory's sweeper releases the hold (→ InventoryReleased(EXPIRED)
 *       → order CANCELLED), Payment's reconciliation fails the payment (→ PaymentFailed → order FAILED), and
 *       {@link OrderReconciliationJob} resolves anything still AWAITING_PAYMENT against Payment Service</td></tr>
 * </table>
 *
 * Every state change is one transaction with its outbox rows; every outbound
 * call runs inside that dependency's circuit breaker.
 */
@Service
public class CheckoutService {

    private static final Logger log = LoggerFactory.getLogger(CheckoutService.class);

    private final OrderRepository orders;
    private final Clients.Cart cart;
    private final Clients.Catalog catalog;
    private final Clients.Inventory inventory;
    private final Clients.Payment payment;
    private final OutboxWriter outbox;
    private final OutboxRelay relay;
    private final OrderProperties properties;
    private final TransactionTemplate tx;
    private final TransactionTemplate readOnlyTx;

    public CheckoutService(OrderRepository orders, Clients.Cart cart, Clients.Catalog catalog, Clients.Inventory inventory,
                           Clients.Payment payment, OutboxWriter outbox, OutboxRelay relay, OrderProperties properties,
                           PlatformTransactionManager transactionManager) {
        this.orders = orders;
        this.cart = cart;
        this.catalog = catalog;
        this.inventory = inventory;
        this.payment = payment;
        this.outbox = outbox;
        this.relay = relay;
        this.properties = properties;
        this.tx = new TransactionTemplate(transactionManager);
        this.readOnlyTx = new TransactionTemplate(transactionManager);
        this.readOnlyTx.setReadOnly(true);
    }

    /** A line whose Catalog price differs from the cart's snapshot. Returned to the UI when the policy is PROCEED. */
    public record PriceChange(String productId, String sku, long cartUnitPriceInPaise, long chargedUnitPriceInPaise) {
    }

    public record CheckoutResult(OrderView order, boolean created, List<PriceChange> priceChanges) {
    }

    public CheckoutResult checkout(String userId, String idempotencyKey, String bodyFingerprintSource) {
        String requestId = Correlation.current();
        String fingerprint = fingerprint(userId, bodyFingerprintSource);

        // ---- Idempotent replay: same key → the original order, whatever state it reached.
        if (idempotencyKey != null) {
            Optional<Order> existing = readOnlyTx.execute(s -> orders.findByUserIdAndIdempotencyKey(userId, idempotencyKey));
            if (existing.isPresent()) {
                return replay(existing.get(), fingerprint);
            }
        }

        // ---- 2. Cart (strict). No order exists yet, so a failure needs no compensation.
        Clients.Cart.Snapshot snapshot;
        try {
            snapshot = cart.snapshot(userId);
        } catch (ServiceClient.Rejected e) {
            throw new CheckoutRejectedException(e.getStatus() == 409 ? 409 : 400, e.getCode(), e.getMessage(), detailsOf(e));
        } catch (ServiceClient.Unavailable e) {
            throw new DependencyUnavailableException("cart_unavailable", "Your cart could not be read right now. Please try again.", e);
        }

        // ---- 3. Fresh prices from Catalog → OUR authoritative total.
        List<String> productIds = snapshot.items().stream().map(Clients.Cart.Line::productId).toList();
        Clients.Catalog.Prices prices;
        try {
            prices = catalog.prices(productIds);
        } catch (ServiceClient.Rejected e) {
            throw new CheckoutRejectedException(409, "pricing_rejected", e.getMessage(), detailsOf(e));
        } catch (ServiceClient.Unavailable e) {
            throw new DependencyUnavailableException("pricing_unavailable", "Prices could not be verified right now. Please try again.", e);
        }
        if (!prices.unavailable().isEmpty()) {
            throw new CheckoutRejectedException(409, "product_unavailable",
                    "Some items are no longer available: " + prices.unavailable().stream().map(u -> u.productId() + " (" + u.reason() + ")").collect(Collectors.joining(", ")),
                    prices.unavailable());
        }
        Map<String, Clients.Catalog.Price> priceById = prices.prices().stream().collect(Collectors.toMap(Clients.Catalog.Price::productId, p -> p));
        List<PriceChange> priceChanges = new ArrayList<>();
        String currency = null;
        for (Clients.Cart.Line line : snapshot.items()) {
            Clients.Catalog.Price p = priceById.get(line.productId());
            if (p == null) {
                throw new CheckoutRejectedException(409, "product_unavailable", "Product " + line.productId() + " has no price", null);
            }
            if (currency == null) {
                currency = p.currency();
            } else if (!currency.equals(p.currency())) {
                throw new CheckoutRejectedException(409, "mixed_currencies", "Cart items are priced in different currencies", null);
            }
            if (p.priceInPaise() != line.unitPriceInPaise()) {
                priceChanges.add(new PriceChange(line.productId(), p.sku(), line.unitPriceInPaise(), p.priceInPaise()));
            }
        }
        if (!priceChanges.isEmpty()) {
            if (properties.priceChangePolicy() == OrderProperties.PriceChangePolicy.REJECT) {
                throw new CheckoutRejectedException(409, "price_changed",
                        "Prices changed since the cart was viewed; review your cart and try again", priceChanges);
            }
            log.info("prices changed since the cart was viewed — proceeding with fresh prices", kv("changes", priceChanges));
        }

        // ---- 4. Persist PENDING with the immutable snapshot (+ OrderCreated in the outbox), one transaction.
        final String cur = currency;
        UUID orderId;
        try {
            orderId = tx.execute(s -> {
                Order o = new Order(userId, cur, idempotencyKey, fingerprint, requestId);
                for (Clients.Cart.Line line : snapshot.items()) {
                    Clients.Catalog.Price p = priceById.get(line.productId());
                    o.addItem(line.productId(), p.sku(), p.name(), line.quantity(), p.priceInPaise());
                }
                o.recordPlaced(requestId);
                orders.saveAndFlush(o);
                outbox.orderEvent(o, OutboxWriter.ORDER_CREATED, null);
                relay.nudgeAfterCommit();
                return o.getId();
            });
        } catch (DataIntegrityViolationException e) {
            // Lost the race on UNIQUE(user_id, idempotency_key): the winner is the order.
            Order winner = readOnlyTx.execute(s -> orders.findByUserIdAndIdempotencyKey(userId, idempotencyKey)).orElseThrow(() -> e);
            return replay(winner, fingerprint);
        }
        log.info("order PENDING — snapshot taken", kv("orderId", orderId), kv("items", snapshot.items().size()),
                kv("totalInPaise", view(orderId).totalInPaise()), kv("currency", currency));

        // ---- 5. Reserve stock — BEFORE money.
        List<Clients.Inventory.ReserveLine> lines = snapshot.items().stream()
                .map(l -> new Clients.Inventory.ReserveLine(l.productId(), l.quantity())).toList();
        Clients.Inventory.Reservation reservation;
        try {
            reservation = inventory.reserve(orderId.toString(), lines);
        } catch (Clients.Inventory.InsufficientStock e) {
            String reason = "insufficient stock: " + e.getShortages().stream()
                    .map(s -> s.productId() + " short by " + s.shortBy()).collect(Collectors.joining(", "));
            fail(orderId, reason, requestId, false);
            throw new CheckoutRejectedException(409, "insufficient_stock", "Some items are out of stock — nothing was charged. " + e.getMessage(), e.getShortages());
        } catch (ServiceClient.Rejected e) {
            fail(orderId, "inventory rejected the reservation: " + e.getCode() + " " + e.getMessage(), requestId, true);
            throw new CheckoutRejectedException(409, "inventory_rejected", e.getMessage(), detailsOf(e));
        } catch (ServiceClient.Unavailable e) {
            // A hold MAY exist if the request reached Inventory and the response was lost: the queued OrderCancelled releases it.
            fail(orderId, "inventory unavailable: " + e.getMessage(), requestId, true);
            throw new DependencyUnavailableException("inventory_unavailable", "Stock could not be reserved right now — nothing was charged. Please try again.", e);
        }
        tx.execute(s -> {
            Order o = orders.lockById(orderId).orElseThrow();
            o.attachReservation(reservation.reservationId(), reservation.expiresAt() != null ? Instant.parse(reservation.expiresAt()) : null);
            o.transitionTo(OrderStatus.RESERVED, Trigger.CHECKOUT, "inventory hold " + reservation.reservationId(), null, requestId);
            return null;
        });
        log.info("order RESERVED", kv("orderId", orderId), kv("reservationId", reservation.reservationId()), kv("expiresAt", reservation.expiresAt()));

        // ---- 6. Create the payment with OUR amount. Failure → release the hold, fail the order.
        OrderView pendingView = view(orderId);
        Clients.Payment.Created created;
        try {
            created = payment.create(orderId.toString(), userId, pendingView.totalInPaise(), pendingView.currency());
        } catch (ServiceClient.Rejected e) {
            compensateReservation(orderId, "payment rejected: " + e.getCode() + " " + e.getMessage(), requestId);
            throw new CheckoutRejectedException(502, "payment_rejected", "The payment could not be set up — nothing was charged and your items were released.", null);
        } catch (ServiceClient.Unavailable e) {
            compensateReservation(orderId, "payment unavailable: " + e.getMessage(), requestId);
            throw new DependencyUnavailableException("payment_unavailable", "Payment is unavailable right now — nothing was charged and your items were released. Please try again.", e);
        }
        if (created.amountInPaise() != pendingView.totalInPaise()) {
            compensateReservation(orderId, "payment amount mismatch: ours " + pendingView.totalInPaise() + ", payment " + created.amountInPaise(), requestId);
            throw new CheckoutRejectedException(502, "payment_rejected", "The payment could not be set up consistently — nothing was charged.", null);
        }
        OrderView result = tx.execute(s -> {
            Order o = orders.lockById(orderId).orElseThrow();
            o.attachPayment(created.paymentId(), created.razorpayOrderId(), created.razorpayKeyId());
            o.transitionTo(OrderStatus.AWAITING_PAYMENT, Trigger.CHECKOUT, "razorpay order " + created.razorpayOrderId() + " created", null, requestId);
            return OrderView.of(o, true);
        });
        log.info("order AWAITING_PAYMENT — user goes to Razorpay", kv("orderId", orderId), kv("razorpayOrderId", created.razorpayOrderId()),
                kv("amountInPaise", created.amountInPaise()));

        // ---- 7. The cart has done its job.
        try {
            cart.clear(userId);
        } catch (RuntimeException e) {
            log.warn("cart could not be cleared after checkout — not critical", kv("orderId", orderId), kv("error", e.getMessage()));
        }
        return new CheckoutResult(result, true, priceChanges);
    }

    /** PENDING → FAILED (nothing reserved for sure, or maybe — the event releases it if so). */
    private void fail(UUID orderId, String reason, String requestId, boolean queueCancelForSafety) {
        tx.execute(s -> {
            Order o = orders.lockById(orderId).orElseThrow();
            o.transitionTo(OrderStatus.FAILED, Trigger.CHECKOUT, reason, null, requestId);
            if (queueCancelForSafety) {
                outbox.orderEvent(o, OutboxWriter.ORDER_CANCELLED, reason);
            }
            relay.nudgeAfterCommit();
            return null;
        });
        log.warn("order FAILED during checkout", kv("orderId", orderId), kv("reason", reason));
    }

    /** RESERVED → FAILED with the hold given back: sync release now, OrderCancelled event as the durable backstop. */
    private void compensateReservation(UUID orderId, String reason, String requestId) {
        tx.execute(s -> {
            Order o = orders.lockById(orderId).orElseThrow();
            o.transitionTo(OrderStatus.FAILED, Trigger.CHECKOUT, reason, null, requestId);
            outbox.orderEvent(o, OutboxWriter.ORDER_CANCELLED, reason);
            relay.nudgeAfterCommit();
            return null;
        });
        try {
            inventory.release(orderId.toString());
            log.warn("order FAILED — inventory hold RELEASED (compensation)", kv("orderId", orderId), kv("reason", reason));
        } catch (RuntimeException e) {
            log.error("order FAILED — sync release failed; the queued OrderCancelled event will release the hold",
                    kv("orderId", orderId), kv("reason", reason), kv("releaseError", e.getMessage()));
        }
    }

    private CheckoutResult replay(Order existing, String fingerprint) {
        if (existing.getIdempotencyFingerprint() != null && !existing.getIdempotencyFingerprint().equals(fingerprint)) {
            throw new IdempotencyConflictException();
        }
        log.info("checkout replayed — returning the original order", kv("orderId", existing.getId()), kv("status", existing.getStatus()));
        return new CheckoutResult(view(existing.getId()), false, List.of());
    }

    OrderView view(UUID orderId) {
        return readOnlyTx.execute(s -> orders.findById(orderId).map(o -> OrderView.of(o, true)).orElseThrow());
    }

    static List<?> detailsOf(ServiceClient.Rejected e) {
        if (e.getDetails() == null || !e.getDetails().isArray()) {
            return null;
        }
        List<Object> out = new ArrayList<>();
        e.getDetails().forEach(out::add);
        return out;
    }

    /** SHA-256 of user + body so the same Idempotency-Key with a different body is detectable. */
    static String fingerprint(String userId, String body) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            md.update(userId.getBytes(StandardCharsets.UTF_8));
            md.update((byte) 0);
            md.update((body == null ? "" : body).getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(md.digest());
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
