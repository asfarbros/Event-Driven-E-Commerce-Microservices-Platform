package com.orderflow.inventory.service;

import java.util.List;

import com.orderflow.inventory.service.InventoryService.Line;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class LockOrderTest {

    @Test
    void locksInTheSameOrderWhateverTheCallerSent() {
        List<Line> ab = List.of(new Line("prod-A", 1), new Line("prod-B", 2));
        List<Line> ba = List.of(new Line("prod-B", 2), new Line("prod-A", 1));

        assertThat(LockOrder.sorted(ab, Line::productId)).extracting(Line::productId).containsExactly("prod-A", "prod-B");
        assertThat(LockOrder.sorted(ba, Line::productId)).extracting(Line::productId).containsExactly("prod-A", "prod-B");
    }

    @Test
    void usesPlainStringOrderSoEveryCallerAgrees() {
        assertThat(LockOrder.sortedIds(List.of("b", "B", "10", "2", "a"))).containsExactly("10", "2", "B", "a", "b");
    }
}
