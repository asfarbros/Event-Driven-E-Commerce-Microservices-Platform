package com.orderflow.inventory.service;

import java.time.Instant;

import com.orderflow.inventory.domain.Inventory;

/** Read model of one inventory row. */
public record StockView(String productId, int available, int reserved, Instant updatedAt) {

    public static StockView of(Inventory i) {
        return new StockView(i.getProductId(), i.getAvailable(), i.getReserved(), i.getUpdatedAt());
    }
}
