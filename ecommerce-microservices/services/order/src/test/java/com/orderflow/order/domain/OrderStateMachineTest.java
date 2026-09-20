package com.orderflow.order.domain;

import java.util.EnumSet;

import com.orderflow.order.domain.Order.Trigger;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Pins the state machine: exactly the documented arrows, idempotent re-application, terminal states are final. */
class OrderStateMachineTest {

    private static Order order() {
        Order o = new Order("user_1", "INR", null, null, "req-1");
        o.addItem("p1", "SKU-1", "Thing", 2, 12500L);
        o.recordPlaced("req-1");
        return o;
    }

    @Test
    void onlyTheDocumentedTransitionsAreAllowed() {
        assertThat(OrderStatus.PENDING.canTransitionTo(OrderStatus.RESERVED)).isTrue();
        assertThat(OrderStatus.PENDING.canTransitionTo(OrderStatus.FAILED)).isTrue();
        assertThat(OrderStatus.PENDING.canTransitionTo(OrderStatus.CONFIRMED)).isFalse();
        assertThat(OrderStatus.RESERVED.canTransitionTo(OrderStatus.AWAITING_PAYMENT)).isTrue();
        assertThat(OrderStatus.RESERVED.canTransitionTo(OrderStatus.CONFIRMED)).isFalse();
        assertThat(OrderStatus.AWAITING_PAYMENT.canTransitionTo(OrderStatus.CONFIRMED)).isTrue();
        assertThat(OrderStatus.AWAITING_PAYMENT.canTransitionTo(OrderStatus.FAILED)).isTrue();
        assertThat(OrderStatus.AWAITING_PAYMENT.canTransitionTo(OrderStatus.CANCELLED)).isTrue();
        assertThat(OrderStatus.CONFIRMED.canTransitionTo(OrderStatus.CANCELLED)).isTrue();
        assertThat(OrderStatus.CONFIRMED.canTransitionTo(OrderStatus.FAILED)).isFalse();
        for (OrderStatus terminal : EnumSet.of(OrderStatus.FAILED, OrderStatus.CANCELLED)) {
            for (OrderStatus target : OrderStatus.values()) {
                assertThat(terminal.canTransitionTo(target)).as(terminal + " -> " + target).isFalse();
            }
        }
    }

    @Test
    void happyPathAppendsHistoryAndTotalsAreIntegerPaise() {
        Order o = order();
        assertThat(o.getTotalInPaise()).isEqualTo(25000L);
        assertThat(o.getItemCount()).isEqualTo(1);
        assertThat(o.getTotalQuantity()).isEqualTo(2);

        assertThat(o.transitionTo(OrderStatus.RESERVED, Trigger.CHECKOUT, "hold", null, "req-1")).isTrue();
        assertThat(o.transitionTo(OrderStatus.AWAITING_PAYMENT, Trigger.CHECKOUT, "rzp", null, "req-1")).isTrue();
        assertThat(o.transitionTo(OrderStatus.CONFIRMED, Trigger.PAYMENT_EVENT, "paid", "evt-1", "req-2")).isTrue();

        assertThat(o.getHistory()).hasSize(4);
        assertThat(o.getHistory().get(0).getFromStatus()).isNull();
        assertThat(o.getHistory().get(3).getToStatus()).isEqualTo(OrderStatus.CONFIRMED);
        assertThat(o.getHistory().get(3).getEventId()).isEqualTo("evt-1");
    }

    @Test
    void reapplyingTheSameStatusIsANoOp() {
        Order o = order();
        o.transitionTo(OrderStatus.RESERVED, Trigger.CHECKOUT, "hold", null, "r");
        o.transitionTo(OrderStatus.AWAITING_PAYMENT, Trigger.CHECKOUT, "rzp", null, "r");
        o.transitionTo(OrderStatus.CONFIRMED, Trigger.PAYMENT_EVENT, "paid", "evt-1", "r");
        int historyBefore = o.getHistory().size();

        assertThat(o.transitionTo(OrderStatus.CONFIRMED, Trigger.PAYMENT_EVENT, "paid again", "evt-1", "r")).isFalse();
        assertThat(o.getHistory()).hasSize(historyBefore);
        assertThat(o.getStatus()).isEqualTo(OrderStatus.CONFIRMED);
    }

    @Test
    void staleEventsCannotResurrectATerminalOrder() {
        Order o = order();
        o.transitionTo(OrderStatus.FAILED, Trigger.CHECKOUT, "out of stock", null, "r");
        assertThat(o.getFailureReason()).isEqualTo("out of stock");

        assertThatThrownBy(() -> o.transitionTo(OrderStatus.CONFIRMED, Trigger.PAYMENT_EVENT, "late", "evt", "r"))
                .isInstanceOf(OrderStatus.IllegalTransitionException.class)
                .hasMessageContaining("FAILED -> CONFIRMED");
        assertThatThrownBy(() -> o.transitionTo(OrderStatus.RESERVED, Trigger.CHECKOUT, "late", null, "r"))
                .isInstanceOf(OrderStatus.IllegalTransitionException.class);
        assertThat(o.getStatus()).isEqualTo(OrderStatus.FAILED);
    }

    @Test
    void userCanCancelOnlyWhileAwaitingPaymentOrConfirmed() {
        assertThat(OrderStatus.AWAITING_PAYMENT.isUserCancellable()).isTrue();
        assertThat(OrderStatus.CONFIRMED.isUserCancellable()).isTrue();
        assertThat(OrderStatus.PENDING.isUserCancellable()).isFalse();
        assertThat(OrderStatus.RESERVED.isUserCancellable()).isFalse();
        assertThat(OrderStatus.FAILED.isUserCancellable()).isFalse();
    }
}
