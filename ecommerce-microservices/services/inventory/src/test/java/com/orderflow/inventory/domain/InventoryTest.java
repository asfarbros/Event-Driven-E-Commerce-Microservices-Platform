package com.orderflow.inventory.domain;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class InventoryTest {

    @Test
    void reserveConfirmReleaseMoveUnitsBetweenTheTwoNumbers() {
        Inventory i = new Inventory("p1", 10);

        i.reserve(4);
        assertThat(i.getAvailable()).isEqualTo(6);
        assertThat(i.getReserved()).isEqualTo(4);

        i.confirm(1);            // reserved -> gone; available untouched
        assertThat(i.getAvailable()).isEqualTo(6);
        assertThat(i.getReserved()).isEqualTo(3);

        i.release(3);            // reserved -> available
        assertThat(i.getAvailable()).isEqualTo(9);
        assertThat(i.getReserved()).isEqualTo(0);
    }

    @Test
    void restockReturnsSoldUnitsToAvailableOnly() {
        Inventory i = new Inventory("p1", 10);
        i.reserve(4);
        i.confirm(4);            // sold: available 6, reserved 0
        i.restock(4);            // paid order cancelled: (gone) -> available
        assertThat(i.getAvailable()).isEqualTo(10);
        assertThat(i.getReserved()).isEqualTo(0);
        assertThatThrownBy(() -> i.restock(0)).isInstanceOf(IllegalStateException.class);
    }

    @Test
    void neverGoesNegative() {
        Inventory i = new Inventory("p1", 1);
        assertThatThrownBy(() -> i.reserve(2)).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> i.release(1)).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> i.confirm(1)).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> i.addAvailable(-2)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> i.setAvailable(-1)).isInstanceOf(IllegalArgumentException.class);
        assertThat(i.getAvailable()).isEqualTo(1);
        assertThat(i.getReserved()).isEqualTo(0);
    }
}
