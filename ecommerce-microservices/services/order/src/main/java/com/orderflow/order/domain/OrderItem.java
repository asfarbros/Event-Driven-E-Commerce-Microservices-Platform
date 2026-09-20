package com.orderflow.order.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.FetchType;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.Table;

/**
 * The immutable line snapshot: what the customer agreed to pay, frozen at
 * checkout. No setters — a later Catalog price change never touches a placed
 * order.
 */
@Entity
@Table(name = "order_item")
public class OrderItem {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "order_id", nullable = false)
    private Order order;

    @Column(name = "product_id", nullable = false, length = 64)
    private String productId;

    @Column(nullable = false, length = 64)
    private String sku;

    @Column(nullable = false, length = 200)
    private String name;

    @Column(nullable = false)
    private int quantity;

    @Column(name = "unit_price_in_paise", nullable = false)
    private long unitPriceInPaise;

    @Column(name = "line_total_in_paise", nullable = false)
    private long lineTotalInPaise;

    @Column(nullable = false, length = 3)
    private String currency;

    protected OrderItem() {
    }

    OrderItem(Order order, String productId, String sku, String name, int quantity, long unitPriceInPaise) {
        this.order = order;
        this.productId = productId;
        this.sku = sku;
        this.name = name;
        this.quantity = quantity;
        this.unitPriceInPaise = unitPriceInPaise;
        this.lineTotalInPaise = Math.multiplyExact(unitPriceInPaise, (long) quantity);
        this.currency = order.getCurrency();
    }

    public Long getId() { return id; }
    public String getProductId() { return productId; }
    public String getSku() { return sku; }
    public String getName() { return name; }
    public int getQuantity() { return quantity; }
    public long getUnitPriceInPaise() { return unitPriceInPaise; }
    public long getLineTotalInPaise() { return lineTotalInPaise; }
    public String getCurrency() { return currency; }
}
