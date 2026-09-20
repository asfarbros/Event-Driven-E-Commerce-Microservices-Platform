package com.orderflow.inventory.domain;

import java.time.Instant;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import jakarta.persistence.Version;

/**
 * One row per product — the two-number stock model.
 *
 * <pre>
 *   available  --reserve-->  reserved  --confirm-->  (gone)
 *   available  <--release--  reserved
 *   available  <--restock--  (gone)        paid order cancelled
 * </pre>
 *
 * Every mutation goes through the methods below so the invariants live in one
 * place; the database CHECK constraints back them up.
 */
@Entity
@Table(name = "inventory")
public class Inventory {

    @Id
    @Column(name = "product_id", nullable = false, length = 64)
    private String productId;

    @Column(nullable = false)
    private int available;

    @Column(nullable = false)
    private int reserved;

    // Wrapper type on purpose: Spring Data treats a null version as "new
    // entity" and uses persist() instead of merge() (no extra SELECT), which
    // matters because both ids are assigned by the application, not the DB.
    @Version
    @Column(nullable = false)
    private Long version;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected Inventory() {
    }

    public Inventory(String productId, int available) {
        this.productId = productId;
        this.available = available;
        this.reserved = 0;
    }

    /** RESERVE: available → reserved. Caller must have checked availability under lock. */
    public void reserve(int quantity) {
        if (quantity <= 0 || quantity > available) {
            throw new IllegalStateException("cannot reserve " + quantity + " of " + productId + " (available " + available + ")");
        }
        available -= quantity;
        reserved += quantity;
    }

    /** CONFIRM: reserved → gone. available is untouched (it already dropped at reserve time). */
    public void confirm(int quantity) {
        if (quantity <= 0 || quantity > reserved) {
            throw new IllegalStateException("cannot confirm " + quantity + " of " + productId + " (reserved " + reserved + ")");
        }
        reserved -= quantity;
    }

    /** RELEASE: reserved → available (cancellation or expiry). */
    public void release(int quantity) {
        if (quantity <= 0 || quantity > reserved) {
            throw new IllegalStateException("cannot release " + quantity + " of " + productId + " (reserved " + reserved + ")");
        }
        reserved -= quantity;
        available += quantity;
    }

    /**
     * RESTOCK: sold units come back. available += quantity; reserved is untouched
     * because confirm() already removed the units from it.
     */
    public void restock(int quantity) {
        if (quantity <= 0) {
            throw new IllegalStateException("cannot restock " + quantity + " of " + productId);
        }
        available += quantity;
    }

    /** Admin restock: set available to an exact figure (reserved untouched). */
    public void setAvailable(int available) {
        if (available < 0) {
            throw new IllegalArgumentException("available cannot be negative");
        }
        this.available = available;
    }

    /** Admin adjust: add (or, with a negative delta, remove) available units. */
    public void addAvailable(int delta) {
        if (available + delta < 0) {
            throw new IllegalArgumentException("available cannot go below zero");
        }
        this.available += delta;
    }

    @PrePersist
    void onCreate() {
        Instant now = Instant.now();
        createdAt = now;
        updatedAt = now;
    }

    @PreUpdate
    void onUpdate() {
        updatedAt = Instant.now();
    }

    public String getProductId() {
        return productId;
    }

    public int getAvailable() {
        return available;
    }

    public int getReserved() {
        return reserved;
    }

    public Long getVersion() {
        return version;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getUpdatedAt() {
        return updatedAt;
    }
}
